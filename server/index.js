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
<<<<<<< HEAD
    try { full = await jellyfinGet(`/Items/${item.Id}?fields=Overview,Taglines,Genres,OfficialRating,CommunityRating,People,MediaStreams`); } catch (e) {}
    let nextUp = null;
=======
try { full = await jellyfinGet(`/Items/${item.Id}?fields=Overview,Taglines,Genres,OfficialRating,CommunityRating,People,MediaStreams`); } catch (e) {}    let nextUp = null;
>>>>>>> f2a51be46530346163e22c7183c79cf99803ee44
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
    if (TMDB_API_KEY) {
      try {
        const type = item.Type === 'Movie' ? 'movie' : 'tv';
        const search = await httpGet(`https://api.themoviedb.org/3/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(item.Name)}&year=${item.ProductionYear||''}`);
        const tmdbId = search.results && search.results[0] ? search.results[0].id : null;
        if (tmdbId) {
          const td = await httpGet(`https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=videos`);
          const t = (td.videos && td.videos.results || []).find(v => v.type === 'Trailer' && v.site === 'YouTube');
          if (t) trailerKey = t.key;
        }
      } catch (e) {}
    }
    const director = (full.People || []).find(p => p.Type === 'Director');
    full.posterUrl = posterUrl(item.Id);
    full.backdropUrl = backdropUrl(item.Id);
    full.RunTimeTicks = full.RunTimeTicks || item.RunTimeTicks;
    nowPlayingCache = {
      item: full,
      positionTicks: ps.PositionTicks || 0,
      runtimeTicks: full.RunTimeTicks || 0,
      isPaused: ps.IsPaused || false,
      sessionUser: playing.UserName || '',
      allUsers: active.map(s => ({ user: s.UserName, title: s.NowPlayingItem.Name, isPaused: s.PlayState.IsPaused })),
      director: director ? director.Name : null,
      trailerKey, nextUp,
    };
    return nowPlayingCache;
  } catch (e) { console.error('[error] getNowPlaying:', e.message); return nowPlayingCache; }
}

// ── Recently Added — track new arrivals ──
let lastRecentIds = new Set();
let newArrivals = [];

const getRecentlyAdded = cached('recent', 60 * 1000, async () => {
  const userId = await getAdminUserId();
  if (!userId) throw new Error('No admin user ID');
  const data = await jellyfinGet(`/Users/${userId}/Items/Latest?MediaType=Video&IncludeItemTypes=Movie&Limit=12&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People`);
  const items = (data || []).map(i => ({
    id: i.Id, title: i.Name, year: i.ProductionYear,
    genre: (i.Genres || []).slice(0, 2).join(' / '),
    rating: i.OfficialRating, score: i.CommunityRating,
    overview: i.Overview,
    cast: (i.People || []).filter(p => p.Type === 'Actor').slice(0, 5).map(p => p.Name),
    director: (i.People || []).find(p => p.Type === 'Director') ? (i.People || []).find(p => p.Type === 'Director').Name : null,
    posterUrl: posterUrl(i.Id), backdropUrl: backdropUrl(i.Id),
  }));

  // Detect new arrivals
  if (lastRecentIds.size > 0) {
    items.forEach(item => {
      if (!lastRecentIds.has(item.id)) {
        newArrivals.push({ ...item, arrivedAt: Date.now() });
        console.log(`[info] New arrival: ${item.title}`);
      }
    });
  }
  lastRecentIds = new Set(items.map(i => i.id));
  // Trim arrivals older than 10 mins
  newArrivals = newArrivals.filter(a => Date.now() - a.arrivedAt < 10 * 60 * 1000);
  return items;
});

const getComingSoon = cached('coming', 60 * 60 * 1000, async () => {
  if (!TMDB_API_KEY) return [];
  const data = await httpGet(`https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_API_KEY}&language=en-US&page=1`);
  return (data.results || []).slice(0, 12).map(m => ({
    id: m.id, title: m.title, year: m.release_date ? m.release_date.split('-')[0] : null,
    releaseDate: m.release_date, overview: m.overview, score: m.vote_average,
    posterUrl: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    backdropUrl: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : null,
  }));
});

const getContinueWatching = cached('continue', 2 * 60 * 1000, async () => {
  const userId = await getAdminUserId();
  if (!userId) return [];
  const data = await jellyfinGet(`/Users/${userId}/Items/Resume?MediaType=Video&Limit=8&fields=Overview,Genres,ProductionYear,OfficialRating,UserData`);
  return (data.Items || []).map(i => ({
    id: i.Id, title: i.Name, year: i.ProductionYear, type: i.Type,
    seriesName: i.SeriesName, genre: (i.Genres || []).slice(0, 1).join(''),
    overview: i.Overview, rating: i.OfficialRating,
    posterUrl: posterUrl(i.Id), backdropUrl: backdropUrl(i.Id),
    progress: i.UserData ? Math.round(i.UserData.PlayedPercentage || 0) : 0,
  }));
});

const getPopular = cached('popular', 30 * 60 * 1000, async () => {
  const data = await jellyfinGet(`/Items?IncludeItemTypes=Movie&SortBy=PlayCount&SortOrder=Descending&Limit=12&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People&Recursive=true`);
  return (data.Items || []).map(i => ({
    id: i.Id, title: i.Name, year: i.ProductionYear,
    genre: (i.Genres || []).slice(0, 2).join(' / '),
    score: i.CommunityRating, overview: i.Overview, rating: i.OfficialRating,
    cast: (i.People || []).filter(p => p.Type === 'Actor').slice(0, 5).map(p => p.Name),
    director: (i.People || []).find(p => p.Type === 'Director') ? (i.People || []).find(p => p.Type === 'Director').Name : null,
    posterUrl: posterUrl(i.Id), backdropUrl: backdropUrl(i.Id),
  }));
});

// ── Watch History ──
const getWatchHistory = cached('history', 5 * 60 * 1000, async () => {
  const userId = await getAdminUserId();
  if (!userId) return [];
  const data = await jellyfinGet(`/Users/${userId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Movie&Recursive=true&Limit=12&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,UserData`);
  return (data.Items || []).map(i => ({
    id: i.Id, title: i.Name, year: i.ProductionYear,
    genre: (i.Genres || []).slice(0, 2).join(' / '),
    score: i.CommunityRating, overview: i.Overview, rating: i.OfficialRating,
    playedDate: i.UserData ? i.UserData.LastPlayedDate : null,
    posterUrl: posterUrl(i.Id), backdropUrl: backdropUrl(i.Id),
  }));
});

// ── On This Day ──
const getOnThisDay = cached('onthisday', 60 * 60 * 1000, async () => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  if (!TMDB_API_KEY) return [];
  try {
    // Search TMDB for movies with today's release date across years
    const results = [];
    for (let y = now.getFullYear() - 30; y < now.getFullYear(); y += 5) {
      try {
        const dateStr = `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const data = await httpGet(`https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}&primary_release_date.gte=${dateStr}&primary_release_date.lte=${dateStr}&sort_by=vote_count.desc`);
        if (data.results && data.results.length) {
          results.push(...data.results.slice(0, 2).map(m => ({
            id: m.id, title: m.title,
            year: m.release_date ? m.release_date.split('-')[0] : null,
            overview: m.overview, score: m.vote_average,
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
  const data = await jellyfinGet(`/Items?IncludeItemTypes=Movie&Recursive=true&SortBy=Random&Limit=1&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People,Taglines`);
  const item = (data.Items || [])[0];
  if (!item) return null;
  return {
    id: item.Id, title: item.Name, year: item.ProductionYear,
    genre: (item.Genres || []).slice(0, 2).join(' / '),
    score: item.CommunityRating, overview: item.Overview,
    tagline: item.Taglines ? item.Taglines[0] : '',
    rating: item.OfficialRating,
    director: (item.People || []).find(p => p.Type === 'Director') ? (item.People || []).find(p => p.Type === 'Director').Name : null,
    cast: (item.People || []).filter(p => p.Type === 'Actor').slice(0, 5).map(p => p.Name),
    posterUrl: posterUrl(item.Id), backdropUrl: backdropUrl(item.Id),
  };
}

// ── Library Search ──
async function searchLibrary(query) {
  if (!query || query.length < 2) return [];
  const userId = await getAdminUserId();
  const endpoint = userId
    ? `/Users/${userId}/Items?SearchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Movie,Series&Recursive=true&Limit=12&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People`
    : `/Items?SearchTerm=${encodeURIComponent(query)}&IncludeItemTypes=Movie,Series&Recursive=true&Limit=12&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating`;
  const data = await jellyfinGet(endpoint);
  return (data.Items || []).map(i => ({
    id: i.Id, title: i.Name, year: i.ProductionYear, type: i.Type,
    genre: (i.Genres || []).slice(0, 2).join(' / '),
    score: i.CommunityRating, overview: i.Overview, rating: i.OfficialRating,
    cast: (i.People || []).filter(p => p.Type === 'Actor').slice(0, 5).map(p => p.Name),
    director: (i.People || []).find(p => p.Type === 'Director') ? (i.People || []).find(p => p.Type === 'Director').Name : null,
    posterUrl: posterUrl(i.Id), backdropUrl: backdropUrl(i.Id),
  }));
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

// ── Server ──
const PUBLIC_DIR = path.resolve('/app/public');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const routes = {
    '/api/now-playing': async () => JSON.stringify(await getNowPlaying() || null),
    '/api/recently-added': async () => { const d = await getRecentlyAdded(); return JSON.stringify(d || []); },
    '/api/coming-soon': async () => JSON.stringify(await getComingSoon() || []),
    '/api/continue-watching': async () => JSON.stringify(await getContinueWatching() || []),
    '/api/popular': async () => JSON.stringify(await getPopular() || []),
    '/api/history': async () => JSON.stringify(await getWatchHistory() || []),
    '/api/on-this-day': async () => JSON.stringify(await getOnThisDay() || []),
    '/api/stats': async () => JSON.stringify(await getStats() || {}),
    '/api/random': async () => JSON.stringify(await getRandomMovie()),
    '/api/new-arrivals': async () => JSON.stringify(newArrivals),
    '/api/search': async () => JSON.stringify(await searchLibrary(parsed.query.q || '')),
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
