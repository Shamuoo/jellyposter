const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const JELLYFIN_URL = (process.env.JELLYFIN_URL || 'http://localhost:8096').replace(/\/$/, '');
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '4000', 10);
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

if (!JELLYFIN_API_KEY) console.warn('[warn] JELLYFIN_API_KEY not set');
if (!TMDB_API_KEY) console.warn('[warn] TMDB_API_KEY not set');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function httpGet(reqUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(reqUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', ...headers },
      timeout: 8000,
    };
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse: ${body.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function jellyfinGet(endpoint) {
  return httpGet(`${JELLYFIN_URL}${endpoint}`, {
    'X-Emby-Authorization': `MediaBrowser Token="${JELLYFIN_API_KEY}"`,
  });
}

function posterUrl(itemId) { return `${JELLYFIN_URL}/Items/${itemId}/Images/Primary?maxWidth=600&api_key=${JELLYFIN_API_KEY}`; }
function backdropUrl(itemId) { return `${JELLYFIN_URL}/Items/${itemId}/Images/Backdrop/0?maxWidth=1920&api_key=${JELLYFIN_API_KEY}`; }

// ── Quality label from media streams ──
function qualityFromStreams(streams) {
  if (!streams) return null;
  const video = streams.find(s => s.Type === 'Video');
  if (!video) return null;
  const h = video.Height || 0;
  // Check for 3D via multiple Jellyfin fields
  const is3D = (
    video.Video3DFormat ||
    (video.DisplayTitle && /\b3d\b/i.test(video.DisplayTitle)) ||
    (video.Title && /\b3d\b/i.test(video.Title)) ||
    streams.some(s => s.DisplayTitle && /\b3d\b/i.test(s.DisplayTitle))
  );
  if (is3D) return '3D';
  if (h >= 2160) return '4K';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  return null;
}

// ── Deduplicate movies by name+year, merging quality tags ──
function deduplicateMovies(items) {
  const map = new Map();
  items.forEach(item => {
    const key = `${item.title}__${item.year}`;
    if (map.has(key)) {
      const existing = map.get(key);
      // Merge quality tags
      const allQualities = [...new Set([...(existing.qualities || []), ...(item.qualities || [])])];
      existing.qualities = allQualities;
      // Keep best quality item as primary
      const qOrder = ['4K', '1080p', '720p', '3D', '480p'];
      const existingBest = qOrder.indexOf(existing.qualities[0]);
      const newBest = qOrder.indexOf(item.qualities[0]);
      if (newBest < existingBest) {
        existing.id = item.id;
        existing.posterUrl = item.posterUrl;
        existing.backdropUrl = item.backdropUrl;
      }
      existing.versionCount = (existing.versionCount || 1) + 1;
    } else {
      map.set(key, { ...item, versionCount: 1 });
    }
  });
  return Array.from(map.values());
}

// ── Map Jellyfin item to standard shape with quality ──
function mapItem(i) {
  const quality = qualityFromStreams(i.MediaStreams);
  return {
    id: i.Id, title: i.Name, year: i.ProductionYear,
    genre: (i.Genres || []).slice(0, 2).join(' / '),
    rating: i.OfficialRating, score: i.CommunityRating,
    overview: i.Overview,
    qualities: quality ? [quality] : [],
    cast: (i.People || []).filter(p => p.Type === 'Actor').slice(0, 5).map(p => p.Name),
    director: (i.People || []).find(p => p.Type === 'Director') ? (i.People || []).find(p => p.Type === 'Director').Name : null,
    posterUrl: posterUrl(i.Id), backdropUrl: backdropUrl(i.Id),
  };
}

// ── Admin user ──
let adminUserId = null;
async function getAdminUserId() {
  if (adminUserId) return adminUserId;
  try {
    const users = await jellyfinGet('/Users');
    const admin = users.find(u => u.Policy && u.Policy.IsAdministrator) || users[0];
    adminUserId = admin ? admin.Id : null;
    console.log(`[info] Admin user: ${adminUserId}`);
    return adminUserId;
  } catch (e) { console.error('[error] getAdminUserId:', e.message); return null; }
}

// ── Cache helper ──
const caches = {};
function cached(key, ttl, fn) {
  return async (...args) => {
    const now = Date.now();
    if (caches[key] && now - caches[key].ts < ttl) return caches[key].data;
    try {
      const data = await fn(...args);
      caches[key] = { ts: now, data };
      return data;
    } catch (e) {
      console.error(`[error] ${key}:`, e.message);
      return caches[key] ? caches[key].data : null;
    }
  };
}

// ── Now Playing ──
let nowPlayingCache = null;
let nowPlayingLastFetch = 0;

async function getNowPlaying() {
  const now = Date.now();
  if (now - nowPlayingLastFetch < POLL_INTERVAL_MS) return nowPlayingCache;
  try {
    const sessions = await jellyfinGet('/Sessions');
    nowPlayingLastFetch = now;
    const active = sessions.filter(s => s.NowPlayingItem && s.PlayState && ['Movie', 'Episode', 'Video'].includes(s.NowPlayingItem.Type));
    if (!active.length) { nowPlayingCache = null; return null; }
    const playing = active.find(s => !s.PlayState.IsPaused) || active[0];
    const item = playing.NowPlayingItem;
    const ps = playing.PlayState;
    let full = item;
    try { full = await jellyfinGet(`/Items/${item.Id}?fields=Overview,Taglines,Genres,OfficialRating,CommunityRating,People,MediaStreams`); } catch (e) {}
    let nextUp = null;
    try {
      if (item.Type === 'Episode' && item.SeriesId) {
        const nd = await jellyfinGet(`/Shows/NextUp?SeriesId=${item.SeriesId}&Limit=1&fields=Overview`);
        if (nd.Items && nd.Items.length) {
          const n = nd.Items[0];
          nextUp = { title: n.SeriesName || n.Name, subtitle: n.SeriesName ? `S${String(n.ParentIndexNumber||0).padStart(2,'0')}E${String(n.IndexNumber||0).padStart(2,'0')} · ${n.Name}` : null, posterUrl: posterUrl(n.Id) };
        }
      }
    } catch (e) {}
    let trailerKey = null;
    let castPhotos = [];
    if (TMDB_API_KEY) {
      try {
        const type = item.Type === 'Movie' ? 'movie' : 'tv';
        const search = await httpGet(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(item.Name)}&year=${item.ProductionYear||''}`);
        const tmdbId = search.results && search.results[0] ? search.results[0].id : null;
        if (tmdbId) {
          const td = await httpGet(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=videos,credits`);
          const t = (td.videos && td.videos.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube');
          if (t) trailerKey = t.key;
          // Get cast photos
          if (td.credits && td.credits.cast) {
            castPhotos = td.credits.cast.slice(0, 5).map(c => c.profile_path || null);
          }
        }
      } catch (e) {}
    }
    const director = (full.People || []).find(p => p.Type === 'Director');
    full.posterUrl = posterUrl(item.Id);
    full.backdropUrl = backdropUrl(item.Id);
    full.RunTimeTicks = full.RunTimeTicks || item.RunTimeTicks;
    const quality = qualityFromStreams(full.MediaStreams);
    nowPlayingCache = {
      item: full,
      positionTicks: ps.PositionTicks || 0,
      runtimeTicks: full.RunTimeTicks || 0,
      isPaused: ps.IsPaused || false,
      sessionUser: playing.UserName || '',
      allUsers: active.map(s => ({ user: s.UserName, title: s.NowPlayingItem.Name, isPaused: s.PlayState.IsPaused })),
      director: director ? director.Name : null,
      quality, trailerKey, nextUp, castPhotos,
    };
    return nowPlayingCache;
  } catch (e) { console.error('[error] getNowPlaying:', e.message); return nowPlayingCache; }
}

// ── Recently Added ──
let lastRecentIds = new Set();
let newArrivals = [];

const getRecentlyAdded = cached('recent', 60 * 1000, async () => {
  const userId = await getAdminUserId();
  if (!userId) throw new Error('No admin user ID');
  const data = await jellyfinGet(`/Users/${userId}/Items/Latest?MediaType=Video&IncludeItemTypes=Movie&Limit=24&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People,MediaStreams`);
  const items = (data || []).map(mapItem);
  const deduped = deduplicateMovies(items).slice(0, 12);
  if (lastRecentIds.size > 0) {
    deduped.forEach(item => {
      if (!lastRecentIds.has(item.id)) {
        newArrivals.push({ ...item, arrivedAt: Date.now() });
        console.log(`[info] New arrival: ${item.title}`);
      }
    });
  }
  lastRecentIds = new Set(deduped.map(i => i.id));
  newArrivals = newArrivals.filter(a => Date.now() - a.arrivedAt < 10 * 60 * 1000);
  return deduped;
});

const getComingSoon = cached('coming', 60 * 60 * 1000, async () => {
  if (!TMDB_API_KEY) return [];
  const data = await httpGet(`https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_API_KEY}&language=en-US&page=1`);
  return (data.results || []).slice(0, 12).map(m => ({
    id: m.id, title: m.title, year: m.release_date ? m.release_date.split('-')[0] : null,
    releaseDate: m.release_date, overview: m.overview, score: m.vote_average,
    qualities: [],
    posterUrl: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdropUrl: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
  }));
});

const getContinueWatching = cached('continue', 2 * 60 * 1000, async () => {
  const userId = await getAdminUserId();
  if (!userId) return [];
  const data = await jellyfinGet(`/Users/${userId}/Items/Resume?MediaType=Video&Limit=16&fields=Overview,Genres,ProductionYear,OfficialRating,UserData,MediaStreams`);
  const items = (data.Items || []).map(i => ({
    ...mapItem(i),
    type: i.Type, seriesName: i.SeriesName,
    progress: i.UserData ? Math.round(i.UserData.PlayedPercentage || 0) : 0,
  }));
  return deduplicateMovies(items).slice(0, 8);
});

const getPopular = cached('popular', 30 * 60 * 1000, async () => {
  const data = await jellyfinGet(`/Items?IncludeItemTypes=Movie&SortBy=PlayCount&SortOrder=Descending&Limit=24&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People,MediaStreams,UserData&Recursive=true&Filters=IsPlayed`);
  const items = (data.Items || []).filter(i => i.UserData && i.UserData.PlayCount > 0).map(mapItem);
  return deduplicateMovies(items).slice(0, 12);
});

const getWatchHistory = cached('history', 5 * 60 * 1000, async () => {
  const userId = await getAdminUserId();
  if (!userId) return [];
  const data = await jellyfinGet(`/Users/${userId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Movie&Recursive=true&Limit=24&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,UserData,MediaStreams`);
  const items = (data.Items || []).map(i => ({ ...mapItem(i), playedDate: i.UserData ? i.UserData.LastPlayedDate : null }));
  return deduplicateMovies(items).slice(0, 12);
});

const getOnThisDay = cached('onthisday', 60 * 60 * 1000, async () => {
  if (!TMDB_API_KEY) return [];
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  try {
    const results = [];
    for (let y = now.getFullYear() - 40; y < now.getFullYear(); y += 5) {
      try {
        const dateStr = `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const data = await httpGet(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&primary_release_date.gte=${dateStr}&primary_release_date.lte=${dateStr}&sort_by=vote_count.desc&vote_count.gte=100`);
        if (data.results && data.results.length) {
          results.push(...data.results.slice(0, 2).map(m => ({
            id: m.id, title: m.title,
            year: m.release_date ? m.release_date.split('-')[0] : null,
            overview: m.overview, score: m.vote_average, qualities: [],
            posterUrl: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
            backdropUrl: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
          })));
        }
      } catch (e) {}
    }
    return results.slice(0, 10);
  } catch (e) { return []; }
});

const getStats = cached('stats', 10 * 60 * 1000, async () => {
  const [movies, shows, episodes] = await Promise.all([
    jellyfinGet('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=0'),
    jellyfinGet('/Items?IncludeItemTypes=Series&Recursive=true&Limit=0'),
    jellyfinGet('/Items?IncludeItemTypes=Episode&Recursive=true&Limit=0'),
  ]);
  return { movies: movies.TotalRecordCount || 0, shows: shows.TotalRecordCount || 0, episodes: episodes.TotalRecordCount || 0 };
});

async function getRandomMovie() {
  const data = await jellyfinGet(`/Items?IncludeItemTypes=Movie&Recursive=true&SortBy=Random&Limit=1&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People,Taglines,MediaStreams`);
  const item = (data.Items || [])[0];
  if (!item) return null;
  const mapped = mapItem(item);
  return { ...mapped, tagline: item.Taglines ? item.Taglines[0] : '' };
}

async function searchLibrary(query) {
  if (!query || query.length < 2) return [];
  const data = await jellyfinGet(`/Items?SearchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Movie,Series&Recursive=true&Limit=24&SortBy=SortName&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People,MediaStreams`);
  const q = query.toLowerCase();
  const items = (data.Items || [])
    .filter(i => i.Name && i.Name.toLowerCase().includes(q))
    .map(i => ({ ...mapItem(i), type: i.Type }));
  return deduplicateMovies(items).slice(0, 12);
}

async function getAllMovies(sortBy, sortOrder, genre, minYear, maxYear, startIndex) {
  let endpoint = `/Items?IncludeItemTypes=Movie&Recursive=true&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,MediaStreams&Limit=96&StartIndex=${startIndex || 0}`;
  endpoint += `&SortBy=${sortBy || 'SortName'}&SortOrder=${sortOrder || 'Ascending'}`;
  if (genre) endpoint += `&Genres=${encodeURIComponent(genre)}`;
  if (minYear) endpoint += `&MinPremiereDate=${minYear}-01-01`;
  if (maxYear) endpoint += `&MaxPremiereDate=${maxYear}-12-31`;
  const data = await jellyfinGet(endpoint);
  const items = (data.Items || []).map(mapItem);
  const deduped = deduplicateMovies(items);
  return {
    total: data.TotalRecordCount || 0,
    items: deduped.slice(0, 48),
  };
}

async function getAllGenres() {
  const data = await jellyfinGet('/Genres?IncludeItemTypes=Movie&Recursive=true&Limit=100');
  return (data.Items || []).map(g => g.Name).sort();
}

const weatherCaches = {};
async function getWeather(city) {
  if (!city) return null;
  const now = Date.now();
  if (weatherCaches[city] && now - weatherCaches[city].ts < 15 * 60 * 1000) return weatherCaches[city].data;
  try {
    const data = await httpGet(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    const cur = data.current_condition[0];
    const result = { city, temp: cur.temp_C, tempF: cur.temp_F, desc: cur.weatherDesc[0].value, humidity: cur.humidity, feelsLike: cur.FeelsLikeC, code: parseInt(cur.weatherCode) };
    weatherCaches[city] = { ts: now, data: result };
    return result;
  } catch (e) { return weatherCaches[city] ? weatherCaches[city].data : null; }
}

const PUBLIC_DIR = path.resolve('/app/public');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const routes = {
    '/api/now-playing': async () => JSON.stringify(await getNowPlaying() || null),
    '/api/recently-added': async () => JSON.stringify(await getRecentlyAdded() || []),
    '/api/coming-soon': async () => JSON.stringify(await getComingSoon() || []),
    '/api/continue-watching': async () => JSON.stringify(await getContinueWatching() || []),
    '/api/popular': async () => JSON.stringify(await getPopular() || []),
    '/api/history': async () => JSON.stringify(await getWatchHistory() || []),
    '/api/on-this-day': async () => JSON.stringify(await getOnThisDay() || []),
    '/api/stats': async () => JSON.stringify(await getStats() || {}),
    '/api/random': async () => JSON.stringify(await getRandomMovie()),
    '/api/new-arrivals': async () => JSON.stringify(newArrivals),
    '/api/search': async () => JSON.stringify(await searchLibrary(parsed.query.q || '')),
    '/api/all-movies': async () => JSON.stringify(await getAllMovies(parsed.query.sort, parsed.query.order, parsed.query.genre, parsed.query.minYear, parsed.query.maxYear, parseInt(parsed.query.start || '0'))),
    '/api/genres': async () => JSON.stringify(await getAllGenres()),
    '/api/weather': async () => JSON.stringify(await getWeather(parsed.query.city || '')),
    '/health': async () => JSON.stringify({ status: 'ok', jellyfin: JELLYFIN_URL, tmdb: !!TMDB_API_KEY }),
  };

  if (routes[pathname]) {
    try {
      const body = await routes[pathname]();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n🎬 JellyPoster`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Jellyfin: ${JELLYFIN_URL}`);
  console.log(`   TMDB: ${TMDB_API_KEY ? 'enabled' : 'disabled'}\n`);
  getAdminUserId();
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
