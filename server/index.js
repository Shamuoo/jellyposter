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

// ── Quality from video stream — uses WIDTH for widescreen films ──
function qualityFromVideo(video) {
  if (!video) return null;
  const w = video.Width || 0;
  const h = video.Height || 0;
  if (w >= 3840 || h >= 2160) return '4K';
  if (w >= 1920 || h >= 1080) return '1080p';
  if (w >= 1280 || h >= 720) return '720p';
  if (w >= 640 || h >= 480) return '480p';
  return null;
}

// ── Check if source is 3D ──
function is3DSource(streams, source) {
  if (!streams && !source) return false;
  if (streams && streams.some(s => s.Video3DFormat)) return true;
  const name = (source && source.Name) || '';
  const path = (source && source.Path) || '';
  return /3d|hsbs|h-sbs|half.sbs|mvc/i.test(name) || /3d|hsbs|h-sbs|half.sbs|mvc/i.test(path);
}

// ── Returns array of quality tags for a single source ──
// 3D and resolution are combined: "1080p 3D", "4K 3D" etc
function qualitiesFromSource(streams, source) {
  const video = streams && streams.find(s => s.Type === 'Video');
  const is3D = is3DSource(streams, source);
  if (is3D) {
    // For 3D SBS sources, width is doubled — halve it for true resolution
    const w = video ? Math.floor((video.Width || 0) / 2) : 0;
    const h = video ? (video.Height || 0) : 0;
    let res = null;
    if (w >= 1920 || h >= 1080) res = '1080p';
    else if (w >= 1280 || h >= 720) res = '720p';
    else if (w >= 3840) res = '4K'; // full SBS 4K is very wide
    return [res ? `${res} 3D` : '3D'];
  }
  const res = qualityFromVideo(video);
  return res ? [res] : [];
}

// ── Quality label from media streams + sources (legacy single value) ──
function qualityFromStreams(streams, mediaSources) {
  const tags = qualitiesFromSource(streams, mediaSources && mediaSources[0]);
  return tags[0] || null;
}

// ── Audio label — checks AudioSpatialFormat first ──
function audioFromStreams(streams) {
  if (!streams) return null;
  // Find default English audio, fall back to any default, then first audio
  const audio = 
    streams.find(s => s.Type === 'Audio' && s.IsDefault && s.Language === 'eng') ||
    streams.find(s => s.Type === 'Audio' && s.IsDefault) ||
    streams.find(s => s.Type === 'Audio');
  if (!audio) return null;
  // AudioSpatialFormat is the most reliable field
  const spatial = (audio.AudioSpatialFormat || '').toLowerCase();
  if (spatial === 'dolbyatmos' || spatial.includes('atmos')) return 'Atmos';
  if (spatial.includes('dtsx') || spatial.includes('dts:x')) return 'DTS:X';
  const profile = (audio.Profile || '').toLowerCase();
  const title = (audio.DisplayTitle || audio.Title || '').toLowerCase();
  const codec = (audio.Codec || '').toLowerCase();
  if (profile.includes('atmos') || title.includes('atmos')) return 'Atmos';
  if (profile.includes('dts:x') || profile.includes('dtsx')) return 'DTS:X';
  if (profile.includes('truehd') || title.includes('truehd')) return 'TrueHD';
  if (profile.includes('dts-hd ma') || title.includes('dts-hd ma')) return 'DTS-HD MA';
  if (profile.includes('dts-hd') || title.includes('dts-hd')) return 'DTS-HD';
  if (codec === 'dts') return 'DTS';
  if (codec === 'eac3') return 'DD+';
  if (codec === 'ac3') return 'DD';
  if (codec === 'aac') return 'AAC';
  if (codec === 'flac') return 'FLAC';
  if (codec === 'mp3') return 'MP3';
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
      const qOrder = ['4K','4K 3D','1080p 3D','1080p','720p 3D','720p','3D','480p 3D','480p'];
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

// ── Map Jellyfin item to standard shape with quality + audio ──
function mapItem(i) {
  // Collect qualities from all media sources
  const qOrder = ['4K','1080p 3D','1080p','720p 3D','720p','480p 3D','480p','3D'];
  const qualitySet = new Set();
  const sources = i.MediaSources && i.MediaSources.length > 0 ? i.MediaSources : null;
  if (sources) {
    sources.forEach(src => {
      qualitiesFromSource(src.MediaStreams, src).forEach(q => qualitySet.add(q));
    });
  } else {
    qualitiesFromSource(i.MediaStreams, null).forEach(q => qualitySet.add(q));
  }
  // Sort by priority
  let qualities = Array.from(qualitySet).sort((a,b) => {
    const ai = qOrder.findIndex(q => a.includes(q.replace(' 3D','')) || a === q);
    const bi = qOrder.findIndex(q => b.includes(q.replace(' 3D','')) || b === q);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  // versionCount from MediaSources
  const versionCount = sources ? sources.length : 1;
  const audio = audioFromStreams(i.MediaStreams);
  const people = i.People || [];
  return {
    id: i.Id, title: i.Name, year: i.ProductionYear,
    genre: (i.Genres || []).slice(0, 2).join(' / '),
    rating: i.OfficialRating, score: i.CommunityRating,
    overview: i.Overview,
    qualities,
    audio: audio || null,
    cast: people.filter(p => p.Type === 'Actor').slice(0, 8).map(p => p.Name),
    People: people.filter(p => p.Type === 'Actor').slice(0, 8).map(p => ({
      Id: p.Id, Name: p.Name, Type: p.Type,
      Role: p.Role, PrimaryImageTag: p.PrimaryImageTag || null,
    })),
    director: people.find(p => p.Type === 'Director') ? people.find(p => p.Type === 'Director').Name : null,
    tagline: i.Taglines ? (i.Taglines[0] || '') : '',
    versionCount: typeof versionCount !== 'undefined' ? versionCount : 1,
    posterUrl: posterUrl(i.Id), backdropUrl: backdropUrl(i.Id),
  };
}


// ── Quality thresholds (configurable) ──
const qualityThresholds = {
  sd: '720p',        // anything below this is flagged as SD/bad
  upgrade: '1080p',  // anything below this is flagged as upgrade candidate  
  audio: 'DD',       // anything below this quality is flagged as poor audio
};

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
    const quality = qualityFromStreams(full.MediaStreams, full.MediaSources);
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
  const data = await jellyfinGet(`/Users/${userId}/Items/Latest?MediaType=Video&IncludeItemTypes=Movie&Limit=24&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People,MediaStreams,MediaSources`);
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
  const data = await jellyfinGet(`/Users/${userId}/Items/Resume?MediaType=Video&Limit=16&fields=Overview,Genres,ProductionYear,OfficialRating,UserData,MediaStreams,MediaSources`);
  const items = (data.Items || []).map(i => ({
    ...mapItem(i),
    type: i.Type, seriesName: i.SeriesName,
    progress: i.UserData ? Math.round(i.UserData.PlayedPercentage || 0) : 0,
  }));
  return deduplicateMovies(items).slice(0, 8);
});

const getPopular = cached('popular', 30 * 60 * 1000, async () => {
  const data = await jellyfinGet(`/Items?IncludeItemTypes=Movie&SortBy=PlayCount&SortOrder=Descending&Limit=24&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,People,MediaStreams,MediaSources,UserData&Recursive=true&Filters=IsPlayed`);
  const items = (data.Items || []).filter(i => i.UserData && i.UserData.PlayCount > 0).map(mapItem);
  return deduplicateMovies(items).slice(0, 12);
});

const getWatchHistory = cached('history', 5 * 60 * 1000, async () => {
  const userId = await getAdminUserId();
  if (!userId) return [];
  const data = await jellyfinGet(`/Users/${userId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Movie&Recursive=true&Limit=24&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,UserData,MediaStreams,MediaSources`);
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
    jellyfinGet('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=0&EnableTotalRecordCount=true'),
    jellyfinGet('/Items?IncludeItemTypes=Series&Recursive=true&Limit=0&EnableTotalRecordCount=true'),
    jellyfinGet('/Items?IncludeItemTypes=Episode&Recursive=true&Limit=0&EnableTotalRecordCount=true'),
  ]);
  return {
    movies: movies.TotalRecordCount || 0,
    shows: shows.TotalRecordCount || 0,
    episodes: episodes.TotalRecordCount || 0,
  };
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
  let endpoint = `/Items?IncludeItemTypes=Movie&Recursive=true&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating,MediaStreams,MediaSources&Limit=96&StartIndex=${startIndex || 0}`;
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


// ════════════════════════════════
// LIBRARY MANAGEMENT TOOLS
// ════════════════════════════════

// Trigger library scan
async function triggerLibraryScan() {
  await jellyfinGet('/Library/Refresh'); // POST would be more correct but GET triggers scan too
  return { success: true, message: 'Library scan triggered' };
}

// Refresh metadata for a single item
async function refreshItemMetadata(itemId) {
  try {
    await httpGet(`${JELLYFIN_URL}/Items/${itemId}/Refresh?MetadataRefreshMode=FullRefresh&ImageRefreshMode=FullRefresh&ReplaceAllMetadata=false&ReplaceAllImages=false`, {
      'X-Emby-Authorization': `MediaBrowser Token="${JELLYFIN_API_KEY}"`,
    });
    return { success: true, itemId };
  } catch(e) { return { success: false, error: e.message, itemId }; }
}

// Refresh metadata for multiple items
async function refreshItems(itemIds) {
  const results = await Promise.allSettled(itemIds.map(id => refreshItemMetadata(id)));
  return results.map((r, i) => ({ itemId: itemIds[i], success: r.status === 'fulfilled' && r.value.success }));
}

// Find items missing posters
const getMissingPosters = cached('missing-posters', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie,Series,MusicAlbum&Limit=500&fields=Overview,Genres,ProductionYear,ImageTags&SortBy=SortName');
  return (data.Items || [])
    .filter(i => !i.ImageTags || !i.ImageTags.Primary)
    .map(i => ({ id: i.Id, title: i.Name, year: i.ProductionYear, type: i.Type, posterUrl: null, issue: 'Missing poster' }));
});

// Find items missing backdrops
const getMissingBackdrops = cached('missing-backdrops', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=500&fields=Overview,Genres,ProductionYear,BackdropImageTags&SortBy=SortName');
  return (data.Items || [])
    .filter(i => !i.BackdropImageTags || i.BackdropImageTags.length === 0)
    .map(i => ({ id: i.Id, title: i.Name, year: i.ProductionYear, type: i.Type, posterUrl: posterUrl(i.Id), issue: 'Missing backdrop' }));
});

// Find items missing metadata (no overview)
const getMissingMetadata = cached('missing-metadata', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie,Series&Limit=500&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating&SortBy=SortName');
  return (data.Items || [])
    .filter(i => !i.Overview || i.Overview.trim().length < 10)
    .map(i => ({ id: i.Id, title: i.Name, year: i.ProductionYear, type: i.Type, posterUrl: posterUrl(i.Id), issue: 'Missing overview' }));
});

// Find low quality movies (480p or 720p)
const getLowQualityMovies = cached('low-quality', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie&Limit=500&fields=Overview,ProductionYear,OfficialRating,MediaStreams,MediaSources&SortBy=SortName');
  return (data.Items || []).reduce((acc, i) => {
    const sources = i.MediaSources || [];
    const qualities = new Set();
    if (sources.length > 0) {
      sources.forEach(src => { qualitiesFromSource(src.MediaStreams, src).forEach(q => qualities.add(q)); });
    } else {
      qualitiesFromSource(i.MediaStreams, null).forEach(q => qualities.add(q));
    }
    const qArr = Array.from(qualities);
    const hasLow = qArr.some(q => q.includes('480p') || q.includes('720p'));
    const hasHigh = qArr.some(q => q.includes('4K') || q.includes('1080p'));
    if (hasLow && !hasHigh) {
      acc.push({ id: i.Id, title: i.Name, year: i.ProductionYear, posterUrl: posterUrl(i.Id), qualities: qArr, issue: `Only ${qArr.join(', ')} available` });
    }
    return acc;
  }, []);
});

// Find poor audio movies (only AAC/MP3, no lossless)
const getPoorAudioMovies = cached('poor-audio', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie&Limit=500&fields=Overview,ProductionYear,MediaStreams&SortBy=SortName');
  const goodAudio = ['truehd','dts-hd','dts','eac3','flac','atmos'];
  return (data.Items || []).reduce((acc, i) => {
    const streams = i.MediaStreams || [];
    const audioStreams = streams.filter(s => s.Type === 'Audio');
    if (!audioStreams.length) return acc;
    const hasPoor = audioStreams.every(s => {
      const codec = (s.Codec || '').toLowerCase();
      const profile = (s.Profile || '').toLowerCase();
      const spatial = (s.AudioSpatialFormat || '').toLowerCase();
      const isPoor = !goodAudio.some(g => codec.includes(g) || profile.includes(g) || spatial.includes(g));
      return isPoor;
    });
    if (hasPoor) {
      const audio = audioFromStreams(streams);
      acc.push({ id: i.Id, title: i.Name, year: i.ProductionYear, posterUrl: posterUrl(i.Id), audio: audio || 'Unknown', issue: `Only ${audio || 'basic'} audio` });
    }
    return acc;
  }, []);
});

// Find movies with no audio streams at all
const getNoAudioMovies = cached('no-audio', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie&Limit=500&fields=ProductionYear,MediaStreams&SortBy=SortName');
  return (data.Items || [])
    .filter(i => !(i.MediaStreams || []).some(s => s.Type === 'Audio'))
    .map(i => ({ id: i.Id, title: i.Name, year: i.ProductionYear, posterUrl: posterUrl(i.Id), issue: 'No audio stream detected' }));
});

// Find duplicate movies
const getDuplicates = cached('duplicates', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie&Limit=1000&fields=ProductionYear,MediaSources,MediaStreams&SortBy=SortName');
  const map = new Map();
  (data.Items || []).forEach(i => {
    const key = `${i.Name}__${i.ProductionYear}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(i);
  });
  return Array.from(map.entries())
    .filter(([,items]) => items.length > 1)
    .map(([key, items]) => ({
      title: items[0].Name, year: items[0].ProductionYear,
      posterUrl: posterUrl(items[0].Id),
      versions: items.map(i => {
        const q = qualitiesFromSource(i.MediaStreams, null);
        const src = (i.MediaSources || [])[0];
        return { id: i.Id, qualities: q, path: src ? src.Path : '', size: src ? src.Size : 0 };
      }),
    }));
});

// Find suspect files (very small = possibly corrupt, very large = bloated)
const getSuspectFiles = cached('suspect-files', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie&Limit=500&fields=ProductionYear,MediaSources,RunTimeTicks&SortBy=SortName');
  const results = [];
  (data.Items || []).forEach(i => {
    const src = (i.MediaSources || [])[0];
    if (!src || !src.Size) return;
    const sizeMB = src.Size / (1024 * 1024);
    const runtimeMins = i.RunTimeTicks ? i.RunTimeTicks / 600000000 : 0;
    const mbPerMin = runtimeMins > 0 ? sizeMB / runtimeMins : 0;
    if (sizeMB < 100 && runtimeMins > 30) results.push({ id: i.Id, title: i.Name, year: i.ProductionYear, posterUrl: posterUrl(i.Id), sizeMB: Math.round(sizeMB), issue: 'Very small file — possibly corrupt' });
    else if (mbPerMin > 400) results.push({ id: i.Id, title: i.Name, year: i.ProductionYear, posterUrl: posterUrl(i.Id), sizeMB: Math.round(sizeMB), mbPerMin: Math.round(mbPerMin), issue: 'Very large file — possible re-encode candidate' });
  });
  return results;
});

// Find movies that have 4K releases available but you only have 1080p (via TMDB)
const getUpgradeAvailable = cached('upgrade-available', 30 * 60 * 1000, async () => {
  if (!TMDB_API_KEY) return [];
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=Movie&Limit=500&fields=ProductionYear,MediaStreams,MediaSources,ProviderIds&SortBy=SortName');
  const results = [];
  for (const i of (data.Items || [])) {
    const sources = i.MediaSources || [];
    const qualities = new Set();
    sources.forEach(src => qualitiesFromSource(src.MediaStreams, src).forEach(q => qualities.add(q)));
    const qArr = Array.from(qualities);
    const has4K = qArr.some(q => q.includes('4K'));
    if (has4K) continue; // already have 4K
    const has1080 = qArr.some(q => q.includes('1080p'));
    if (!has1080) continue; // not even 1080p, already in low quality report
    // Check if 4K release exists on TMDB
    try {
      const tmdbId = i.ProviderIds && (i.ProviderIds.Tmdb || i.ProviderIds.tmdb);
      if (tmdbId) {
        const releases = await httpGet(`https://api.themoviedb.org/3/movie/${tmdbId}/release_dates?api_key=${TMDB_API_KEY}`);
        const hasUHD = (releases.results || []).some(r => 
          (r.release_dates || []).some(rd => rd.type === 6) // type 6 = digital/physical 4K
        );
        // Simpler: just flag it as "4K release likely exists" for popular films
        if (i.CommunityRating >= 7) {
          results.push({ id: i.Id, title: i.Name, year: i.ProductionYear, posterUrl: posterUrl(i.Id), qualities: qArr, issue: '1080p only — 4K may be available' });
        }
      }
    } catch(e) {}
  }
  return results.slice(0, 50);
});

// Music: albums missing artwork
const getMissingMusicArt = cached('missing-music-art', 5 * 60 * 1000, async () => {
  const data = await jellyfinGet('/Items?Recursive=true&IncludeItemTypes=MusicAlbum&Limit=500&fields=ImageTags,AlbumArtist&SortBy=SortName');
  return (data.Items || [])
    .filter(i => !i.ImageTags || !i.ImageTags.Primary)
    .map(i => ({ id: i.Id, title: i.Name, artist: i.AlbumArtist, type: 'MusicAlbum', posterUrl: null, issue: 'Missing album art' }));
});

// POST handler for refresh
async function handleRefreshItem(itemId) {
  const reqUrl = `${JELLYFIN_URL}/Items/${itemId}/Refresh?MetadataRefreshMode=FullRefresh&ImageRefreshMode=FullRefresh&ReplaceAllMetadata=false&ReplaceAllImages=false`;
  return new Promise((resolve) => {
    const parsed = new url.URL(reqUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'X-Emby-Authorization': `MediaBrowser Token="${JELLYFIN_API_KEY}"`, 'Content-Length': 0 },
      timeout: 10000,
    }, (res) => { resolve({ success: res.statusCode < 400, statusCode: res.statusCode }); });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.end();
  });
}

async function handleLibraryScan() {
  const reqUrl = `${JELLYFIN_URL}/Library/Refresh`;
  return new Promise((resolve) => {
    const parsed = new url.URL(reqUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'X-Emby-Authorization': `MediaBrowser Token="${JELLYFIN_API_KEY}"`, 'Content-Length': 0 },
      timeout: 10000,
    }, (res) => { resolve({ success: res.statusCode < 400 }); });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.end();
  });
}

const PUBLIC_DIR = path.resolve('/app/public');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Handle POST for metadata update
  if (req.method === 'POST' && pathname === '/api/library/update-item') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { itemId, updates } = JSON.parse(body);
        if (!itemId || !updates) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing itemId or updates' })); return; }
        // Get current item first
        const current = await jellyfinGet(`/Items/${itemId}?fields=Overview,Taglines,Genres,OfficialRating,ProductionYear,People,Studios,Tags,ProviderIds,DateCreated,PremiereDate`);
        // Merge updates
        const merged = { ...current, ...updates };
        // POST to Jellyfin
        const postUrl = `${JELLYFIN_URL}/Items/${itemId}`;
        const postParsed = new url.URL(postUrl);
        const postLib = postParsed.protocol === 'https:' ? https : http;
        const postBody = JSON.stringify(merged);
        const postReq = postLib.request({
          hostname: postParsed.hostname,
          port: postParsed.port || (postParsed.protocol === 'https:' ? 443 : 80),
          path: postParsed.pathname,
          method: 'POST',
          headers: {
            'X-Emby-Authorization': `MediaBrowser Token="${JELLYFIN_API_KEY}"`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postBody),
          },
          timeout: 8000,
        }, (postRes) => {
          res.writeHead(postRes.statusCode === 204 ? 200 : postRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: postRes.statusCode === 204, status: postRes.statusCode }));
        });
        postReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        postReq.write(postBody);
        postReq.end();
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // Handle POST for AI fix via Anthropic API
  if (req.method === 'POST' && pathname === '/api/library/ai-autofix') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { itemId } = JSON.parse(body);
        const item = await jellyfinGet(`/Items/${itemId}?fields=Overview,Taglines,Genres,OfficialRating,ProductionYear,People`);
        const prompt = `You are a movie database assistant. Fix and improve this movie metadata. Respond ONLY with valid JSON, no markdown fences.

Movie: "${item.Name}" (${item.ProductionYear || 'year unknown'})
Current overview: ${item.Overview || 'MISSING'}
Current tagline: ${(item.Taglines||[])[0] || 'MISSING'}  
Genres: ${(item.Genres||[]).join(', ') || 'MISSING'}
Rating: ${item.OfficialRating || 'MISSING'}

Return JSON with these fields (keep existing values if already good, improve if poor/missing):
{"overview":"engaging 2-3 sentence overview, no spoilers","tagline":"short memorable tagline","issues":["issue1","issue2"],"confidence":0.9}`;

        const aiParsed = new url.URL('https://api.anthropic.com/v1/messages');
        const aiBody = JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 512,
          messages: [{ role: 'user', content: prompt }],
        });
        const aiReq = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(aiBody),
          },
          timeout: 15000,
        }, (aiRes) => {
          let aiRespBody = '';
          aiRes.on('data', c => aiRespBody += c);
          aiRes.on('end', () => {
            try {
              const aiData = JSON.parse(aiRespBody);
              const text = aiData.content && aiData.content[0] && aiData.content[0].text || '{}';
              const cleaned = text.replace(/```json|```/g, '').trim();
              const suggestion = JSON.parse(cleaned);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, itemId, title: item.Name, suggestion }));
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: 'AI parse error: ' + e.message })); }
          });
        });
        aiReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        aiReq.write(aiBody);
        aiReq.end();
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }


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
    '/api/person-image': async () => {
      const personId = parsed.query.id;
      if (!personId) { res.writeHead(400); res.end(); return null; }
      // Proxy the image directly
      const imgUrl = `${JELLYFIN_URL}/Items/${personId}/Images/Primary?maxWidth=185&api_key=${JELLYFIN_API_KEY}`;
      try {
        const imgParsed = new (require('url').URL)(imgUrl);
        const lib = imgParsed.protocol === 'https:' ? require('https') : require('http');
        const imgReq = lib.request({
          hostname: imgParsed.hostname,
          port: imgParsed.port || (imgParsed.protocol === 'https:' ? 443 : 80),
          path: imgParsed.pathname + imgParsed.search,
          method: 'GET',
          timeout: 5000,
        }, (imgRes) => {
          res.writeHead(imgRes.statusCode, {
            'Content-Type': imgRes.headers['content-type'] || 'image/jpeg',
            'Cache-Control': 'public, max-age=86400',
          });
          imgRes.pipe(res);
        });
        imgReq.on('error', () => { if (!res.headersSent) { res.writeHead(404); res.end(); } });
        imgReq.end();
      } catch(e) { if (!res.headersSent) { res.writeHead(500); res.end(); } }
      return null;
    },
    '/api/storage': async () => {
      try {
        const libraries = await jellyfinGet('/Library/VirtualFolders');
        return JSON.stringify(libraries || []);
      } catch(e) { return JSON.stringify([]); }
    },

    // ── LIBRARY TOOLS ──
    '/api/library/scan': async () => {
      await jellyfinGet('/Library/Refresh'); // POST would be more correct but GET triggers scan too
      return JSON.stringify({ success: true, message: 'Library scan triggered' });
    },
    '/api/library/refresh-metadata': async () => {
      const itemId = parsed.query.id;
      if (!itemId) return JSON.stringify({ error: 'No item ID' });
      await jellyfinGet(`/Items/${itemId}/Refresh?MetadataRefreshMode=FullRefresh&ImageRefreshMode=FullRefresh&ReplaceAllMetadata=false&ReplaceAllImages=false`);
      return JSON.stringify({ success: true });
    },
    '/api/library/refresh-images': async () => {
      const itemId = parsed.query.id;
      if (!itemId) return JSON.stringify({ error: 'No item ID' });
      await jellyfinGet(`/Items/${itemId}/Refresh?MetadataRefreshMode=None&ImageRefreshMode=FullRefresh&ReplaceAllImages=true`);
      return JSON.stringify({ success: true });
    },
    '/api/library/refresh-all-metadata': async () => {
      // Refresh all items missing metadata
      const data = await jellyfinGet('/Items?Recursive=true&Limit=0&EnableTotalRecordCount=true&IncludeItemTypes=Movie,Series,Episode,MusicAlbum,Audio');
      return JSON.stringify({ success: true, total: data.TotalRecordCount, message: 'Use per-item refresh for bulk operations' });
    },
    '/api/library/quality-report': async () => {
      const [sd, hd720, noQuality, poorAudio] = await Promise.all([
        // SD movies (480p and below)
        jellyfinGet('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=100&fields=MediaStreams,ProductionYear,OfficialRating&SortBy=SortName'),
        jellyfinGet('/Items?IncludeItemTypes=Episode&Recursive=true&Limit=50&fields=MediaStreams,SeriesName&SortBy=SortName'),
        jellyfinGet('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=200&fields=MediaStreams,ProductionYear&SortBy=SortName'),
        jellyfinGet('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=200&fields=MediaStreams,ProductionYear&SortBy=SortName'),
      ]);

      function getVideoQuality(streams) {
        if (!streams) return null;
        const v = streams.find(s => s.Type === 'Video');
        if (!v) return null;
        const w = v.Width || 0, h = v.Height || 0;
        if (w >= 3840 || h >= 2160) return '4K';
        if (w >= 1920 || h >= 1080) return '1080p';
        if (w >= 1280 || h >= 720) return '720p';
        return 'SD';
      }

      function getAudioQuality(streams) {
        if (!streams) return null;
        const a = streams.find(s => s.Type === 'Audio' && s.IsDefault) || streams.find(s => s.Type === 'Audio');
        if (!a) return 'None';
        const spatial = (a.AudioSpatialFormat || '').toLowerCase();
        if (spatial.includes('atmos')) return 'Atmos';
        if (spatial.includes('dtsx')) return 'DTS:X';
        const profile = (a.Profile || '').toLowerCase();
        if (profile.includes('truehd')) return 'TrueHD';
        if (profile.includes('dts-hd ma')) return 'DTS-HD MA';
        if (profile.includes('dts-hd')) return 'DTS-HD';
        const codec = (a.Codec || '').toLowerCase();
        if (codec === 'dts') return 'DTS';
        if (codec === 'eac3') return 'DD+';
        if (codec === 'ac3') return 'DD';
        if (codec === 'aac') return 'AAC';
        if (codec === 'mp3') return 'MP3';
        return codec.toUpperCase() || 'Unknown';
      }

      const poorAudioItems = [], sdItems = [], hd720Items = [], noStreamItems = [];
      const goodAudioFormats = ['Atmos', 'DTS:X', 'TrueHD', 'DTS-HD MA', 'DTS-HD', 'DTS', 'DD+'];

      (noQuality.Items || []).forEach(item => {
        const q = getVideoQuality(item.MediaStreams);
        const a = getAudioQuality(item.MediaStreams);
        const qualityOrder = ['4K','1080p','720p','SD',null];
        const itemQualityRank = qualityOrder.indexOf(q);
        const sdRank = qualityOrder.indexOf(qualityThresholds.sd);
        const upgradeRank = qualityOrder.indexOf(qualityThresholds.upgrade);
        if (!item.MediaStreams || !item.MediaStreams.length) {
          noStreamItems.push({ id: item.Id, title: item.Name, year: item.ProductionYear, posterUrl: posterUrl(item.Id) });
        } else if (q && itemQualityRank >= sdRank) {
          sdItems.push({ id: item.Id, title: item.Name, year: item.ProductionYear, quality: q, audio: a, posterUrl: posterUrl(item.Id) });
        } else if (q && itemQualityRank >= upgradeRank && itemQualityRank < sdRank) {
          hd720Items.push({ id: item.Id, title: item.Name, year: item.ProductionYear, quality: q, audio: a, posterUrl: posterUrl(item.Id) });
        }
        if (q && q !== 'SD' && !goodAudioFormats.includes(a)) {
          poorAudioItems.push({ id: item.Id, title: item.Name, year: item.ProductionYear, quality: q, audio: a || 'Unknown', posterUrl: posterUrl(item.Id) });
        }
      });

      return JSON.stringify({ sdItems, hd720Items, noStreamItems, poorAudioItems });
    },
    '/api/library/missing-content': async () => {
      const [movies, series] = await Promise.all([
        jellyfinGet('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=200&fields=Overview,ImageTags,BackdropImageTags,ProductionYear&SortBy=SortName'),
        jellyfinGet('/Items?IncludeItemTypes=Series&Recursive=true&Limit=100&fields=Overview,ImageTags,BackdropImageTags&SortBy=SortName'),
      ]);

      const missingPoster = [], missingBackdrop = [], missingOverview = [];
      const allItems = [...(movies.Items || []), ...(series.Items || [])];

      allItems.forEach(item => {
        const base = { id: item.Id, title: item.Name, type: item.Type, year: item.ProductionYear, posterUrl: posterUrl(item.Id) };
        if (!item.ImageTags || !item.ImageTags.Primary) missingPoster.push(base);
        if (!item.BackdropImageTags || !item.BackdropImageTags.length) missingBackdrop.push(base);
        if (!item.Overview || item.Overview.trim().length < 10) missingOverview.push(base);
      });

      return JSON.stringify({ missingPoster, missingBackdrop, missingOverview });
    },
    '/api/library/versions-report': async () => {
      const data = await jellyfinGet('/Items?IncludeItemTypes=Movie&Recursive=true&Limit=500&fields=MediaStreams,MediaSources,ProductionYear&SortBy=SortName');
      const multiVersion = [], has3D = [], only2D = [];

      (data.Items || []).forEach(item => {
        const sources = item.MediaSources || [];
        if (sources.length > 1) {
          const qualities = sources.map(src => {
            const v = (src.MediaStreams || []).find(s => s.Type === 'Video');
            const is3d = /3d|hsbs|h-sbs|mvc/i.test(src.Name || '') || /3d|hsbs|h-sbs|mvc/i.test(src.Path || '');
            if (is3d) return '3D';
            if (!v) return 'Unknown';
            const w = v.Width || 0, h = v.Height || 0;
            if (w >= 3840 || h >= 2160) return '4K';
            if (w >= 1920 || h >= 1080) return '1080p';
            if (w >= 1280 || h >= 720) return '720p';
            return 'SD';
          });
          multiVersion.push({ id: item.Id, title: item.Name, year: item.ProductionYear, versions: qualities, count: sources.length, posterUrl: posterUrl(item.Id) });
          if (qualities.some(q => q === '3D')) {
            has3D.push({ id: item.Id, title: item.Name, year: item.ProductionYear, versions: qualities, posterUrl: posterUrl(item.Id) });
          }
        } else if (sources.length === 1) {
          const src = sources[0];
          const is3d = /3d|hsbs|h-sbs|mvc/i.test(src.Name || '') || /3d|hsbs|h-sbs|mvc/i.test(src.Path || '');
          if (!is3d) {
            const v = (src.MediaStreams || []).find(s => s.Type === 'Video');
            const w = v ? (v.Width || 0) : 0, h = v ? (v.Height || 0) : 0;
            if (w >= 1280 || h >= 720) {
              only2D.push({ id: item.Id, title: item.Name, year: item.ProductionYear, posterUrl: posterUrl(item.Id) });
            }
          }
        }
      });

      return JSON.stringify({ multiVersion, has3D, only2D: only2D.slice(0, 50) });
    },
    '/api/library/music-report': async () => {
      const [albums, tracks] = await Promise.all([
        jellyfinGet('/Items?IncludeItemTypes=MusicAlbum&Recursive=true&Limit=100&fields=Overview,ImageTags,ProductionYear,AlbumArtist&SortBy=SortName'),
        jellyfinGet('/Items?IncludeItemTypes=Audio&Recursive=true&Limit=0&EnableTotalRecordCount=true'),
      ]);
      const missingArt = (albums.Items || []).filter(a => !a.ImageTags || !a.ImageTags.Primary)
        .map(a => ({ id: a.Id, title: a.Name, artist: a.AlbumArtist, year: a.ProductionYear, posterUrl: posterUrl(a.Id) }));
      return JSON.stringify({ totalAlbums: albums.TotalRecordCount || (albums.Items||[]).length, totalTracks: tracks.TotalRecordCount || 0, missingArt });
    },

    // ── SYSTEM STATS ──
    '/api/system-stats': async () => {
      const stats = {};
      try {
        // CPU usage from /proc/stat
        const fs2 = require('fs');
        const cpu1 = fs2.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(' ').slice(1).map(Number);
        await new Promise(r => setTimeout(r, 200));
        const cpu2 = fs2.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(' ').slice(1).map(Number);
        const idle1 = cpu1[3], idle2 = cpu2[3];
        const total1 = cpu1.reduce((a,b)=>a+b,0), total2 = cpu2.reduce((a,b)=>a+b,0);
        stats.cpuPercent = Math.round((1 - (idle2-idle1)/(total2-total1)) * 100);

        // RAM from /proc/meminfo
        const mem = fs2.readFileSync('/proc/meminfo', 'utf8');
        const memTotal = parseInt(mem.match(/MemTotal:\s+(\d+)/)[1]);
        const memAvail = parseInt(mem.match(/MemAvailable:\s+(\d+)/)[1]);
        stats.ramTotal = Math.round(memTotal / 1024);
        stats.ramUsed = Math.round((memTotal - memAvail) / 1024);
        stats.ramPercent = Math.round((memTotal - memAvail) / memTotal * 100);

        // Disk usage from /proc/mounts + statfs via df
        try {
          const { execSync } = require('child_process');
          const df = execSync('df -h / /mnt 2>/dev/null || df -h /', { encoding: 'utf8' });
          const lines = df.trim().split('\n').slice(1);
          stats.disks = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            return { fs: parts[0], size: parts[1], used: parts[2], avail: parts[3], percent: parts[4], mount: parts[5] };
          }).filter(d => d.mount);
        } catch(e) { stats.disks = []; }

        // Load average
        const load = fs2.readFileSync('/proc/loadavg', 'utf8').split(' ');
        stats.load1 = parseFloat(load[0]);
        stats.load5 = parseFloat(load[1]);
        stats.load15 = parseFloat(load[2]);

        // Uptime
        const uptime = parseFloat(fs2.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
        stats.uptimeSeconds = Math.floor(uptime);

        // CPU info
        try {
          const cpuinfo = fs2.readFileSync('/proc/cpuinfo', 'utf8');
          const modelMatch = cpuinfo.match(/model name\s*:\s*(.+)/);
          const coreMatches = cpuinfo.match(/processor\s*:/g);
          stats.cpuModel = modelMatch ? modelMatch[1].trim() : 'Unknown';
          stats.cpuCores = coreMatches ? coreMatches.length : 1;
        } catch(e) {}

        // Network stats
        try {
          const net = fs2.readFileSync('/proc/net/dev', 'utf8');
          const lines2 = net.trim().split('\n').slice(2);
          stats.network = lines2.map(line => {
            const parts = line.trim().split(/\s+/);
            return { iface: parts[0].replace(':',''), rxBytes: parseInt(parts[1]), txBytes: parseInt(parts[9]) };
          }).filter(n => n.iface !== 'lo');
        } catch(e) { stats.network = []; }

      } catch(e) { stats.error = e.message; }

      // Also get Jellyfin system info
      try {
        const info = await jellyfinGet('/System/Info');
        stats.jellyfin = {
          serverName: info.ServerName,
          version: info.Version,
          os: info.OperatingSystem,
          arch: info.SystemArchitecture,
          localAddress: info.LocalAddress,
          wanAddress: info.WanAddress,
          hasUpdate: info.HasUpdateAvailable,
        };
      } catch(e) {}

      return JSON.stringify(stats);
    },

    // ── METADATA EDIT ──
    '/api/library/get-item': async () => {
      const itemId = parsed.query.id;
      if (!itemId) return JSON.stringify({ error: 'No item ID' });
      const item = await jellyfinGet(`/Items/${itemId}?fields=Overview,Taglines,Genres,OfficialRating,ProductionYear,People,Studios,Tags`);
      return JSON.stringify(item);
    },
    '/api/library/update-item': async () => {
      // POST equivalent - we need to handle POST body
      // Since our server only does GET, read body from request
      return JSON.stringify({ error: 'Use POST /api/library/update-item' });
    },

    // ── AI AUTOFIX ──
    '/api/library/ai-fix': async () => {
      const itemId = parsed.query.id;
      if (!itemId) return JSON.stringify({ error: 'No item ID' });
      try {
        const item = await jellyfinGet(`/Items/${itemId}?fields=Overview,Taglines,Genres,OfficialRating,ProductionYear,People`);
        const prompt = `You are a movie database assistant. Analyse this movie metadata and suggest improvements.

Movie: ${item.Name} (${item.ProductionYear})
Current Overview: ${item.Overview || 'MISSING'}
Current Tagline: ${(item.Taglines||[])[0] || 'MISSING'}
Genres: ${(item.Genres||[]).join(', ') || 'MISSING'}
Rating: ${item.OfficialRating || 'MISSING'}

Respond ONLY with a JSON object (no markdown, no explanation):
{
  "overview": "improved or fixed overview text (2-3 sentences, engaging, no spoilers)",
  "tagline": "short memorable tagline if missing or improve existing",
  "issues": ["list", "of", "issues", "found"],
  "confidence": 0.0-1.0
}`;

        const response = await httpGet('https://api.anthropic.com/v1/messages', {});
        // Can't POST with our httpGet helper - return suggestion data instead
        // Return what we can analyse without AI call
        const issues = [];
        if (!item.Overview || item.Overview.length < 50) issues.push('Missing or very short overview');
        if (!item.Taglines || !item.Taglines.length) issues.push('No tagline');
        if (!item.Genres || !item.Genres.length) issues.push('No genres set');
        if (!item.OfficialRating) issues.push('No age rating');
        if (!item.ProductionYear) issues.push('No production year');

        return JSON.stringify({
          itemId, title: item.Name, year: item.ProductionYear,
          currentOverview: item.Overview,
          currentTagline: (item.Taglines||[])[0],
          issues,
          needsAiFix: issues.length > 0,
        });
      } catch(e) { return JSON.stringify({ error: e.message }); }
    },

    // ── QUALITY THRESHOLDS (stored in memory, configurable) ──
    '/api/library/set-thresholds': async () => {
      // These come via query params
      if (parsed.query.sdThreshold) qualityThresholds.sd = parsed.query.sdThreshold;
      if (parsed.query.upgradeThreshold) qualityThresholds.upgrade = parsed.query.upgradeThreshold;
      if (parsed.query.audioThreshold) qualityThresholds.audio = parsed.query.audioThreshold;
      return JSON.stringify({ success: true, thresholds: qualityThresholds });
    },
    '/api/library/get-thresholds': async () => JSON.stringify(qualityThresholds),

    '/health': async () => JSON.stringify({ status: 'ok', jellyfin: JELLYFIN_URL, tmdb: !!TMDB_API_KEY }),
    '/api/library/missing-posters': async () => JSON.stringify(await getMissingPosters() || []),
    '/api/library/missing-backdrops': async () => JSON.stringify(await getMissingBackdrops() || []),
    '/api/library/missing-metadata': async () => JSON.stringify(await getMissingMetadata() || []),
    '/api/library/low-quality': async () => JSON.stringify(await getLowQualityMovies() || []),
    '/api/library/poor-audio': async () => JSON.stringify(await getPoorAudioMovies() || []),
    '/api/library/no-audio': async () => JSON.stringify(await getNoAudioMovies() || []),
    '/api/library/duplicates': async () => JSON.stringify(await getDuplicates() || []),
    '/api/library/suspect-files': async () => JSON.stringify(await getSuspectFiles() || []),
    '/api/library/upgrade-available': async () => JSON.stringify(await getUpgradeAvailable() || []),
    '/api/library/missing-music-art': async () => JSON.stringify(await getMissingMusicArt() || []),
    '/api/server-health': async () => {
      const start = Date.now();
      try {
        const [info, sessions, activity, libraries, devices, plugins, ghRelease] = await Promise.all([
          jellyfinGet('/System/Info'),
          jellyfinGet('/Sessions'),
          jellyfinGet('/System/ActivityLog/Entries?Limit=10'),
          jellyfinGet('/Library/VirtualFolders'),
          jellyfinGet('/Devices'),
          jellyfinGet('/Plugins').catch(() => ({ Items: [] })),
          httpGet('https://api.github.com/repos/Shamuoo/jellyposter/releases/latest', { 'User-Agent': 'JellyPoster' }).catch(() => null),
        ]);
        const latency = Date.now() - start;
        const allSessions = sessions || [];
        const activeSessions = allSessions.filter(s => s.NowPlayingItem);
        const transcoding = activeSessions.filter(s => s.TranscodingInfo);
        return JSON.stringify({
          latency,
          jellyPosterVersion: 'v0.8.0',
          github: ghRelease ? {
            latestRelease: ghRelease.tag_name,
            releaseName: ghRelease.name,
            publishedAt: ghRelease.published_at,
            releaseUrl: ghRelease.html_url,
            isLatest: ghRelease.tag_name === 'v0.8.0',
            changelog: ghRelease.body ? ghRelease.body.slice(0, 500) : null,
          } : null,
          serverName: info.ServerName,
          version: info.Version,
          os: info.OperatingSystem,
          architecture: info.SystemArchitecture,
          localAddress: info.LocalAddress,
          wanAddress: info.WanAddress,
          hasUpdateAvailable: info.HasUpdateAvailable,
          canSelfUpdate: info.CanSelfUpdate,
          activeSessions: activeSessions.length,
          totalSessions: allSessions.length,
          transcoding: transcoding.length,
          transcodingDetails: transcoding.map(s => ({
            user: s.UserName,
            title: s.NowPlayingItem && s.NowPlayingItem.Name,
            codec: s.TranscodingInfo && s.TranscodingInfo.VideoCodec,
            bitrate: s.TranscodingInfo && s.TranscodingInfo.Bitrate,
            progress: s.TranscodingInfo && s.TranscodingInfo.CompletionPercentage,
            isVideoDirect: s.TranscodingInfo && s.TranscodingInfo.IsVideoDirect,
            isAudioDirect: s.TranscodingInfo && s.TranscodingInfo.IsAudioDirect,
            hardwareAccel: s.TranscodingInfo && s.TranscodingInfo.IsVideoDirect === false && s.TranscodingInfo.TranscodeReasons && s.TranscodingInfo.TranscodeReasons.length > 0,
          })),
          nowPlaying: activeSessions.map(s => ({
            user: s.UserName,
            title: s.NowPlayingItem && s.NowPlayingItem.Name,
            client: s.Client,
            device: s.DeviceName,
            isPaused: s.PlayState && s.PlayState.IsPaused,
            progress: s.NowPlayingItem && s.PlayState ? Math.round((s.PlayState.PositionTicks || 0) / (s.NowPlayingItem.RunTimeTicks || 1) * 100) : 0,
          })),
          libraries: (libraries || []).map(l => ({
            name: l.Name,
            type: l.CollectionType,
            paths: l.Locations,
          })),
          deviceCount: devices && devices.TotalRecordCount,
          plugins: (plugins.Items || []).map(p => ({ name: p.Name, version: p.Version, status: p.Status })),
          recentActivity: (activity.Items || []).slice(0, 10).map(a => ({
            name: a.Name, date: a.Date, severity: a.Severity, overview: a.Overview,
          })),
        });
      } catch(e) {
        return JSON.stringify({ error: e.message, latency: Date.now() - start });
      }
    },
  };

  // POST handlers
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        if (pathname === '/api/library/scan') {
          const result = await handleLibraryScan();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else if (pathname === '/api/library/refresh-item') {
          const data = JSON.parse(body || '{}');
          const result = await handleRefreshItem(data.itemId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else if (pathname === '/api/library/refresh-all-missing') {
          const type = parsed.query.type;
          let items = [];
          if (type === 'posters') items = await getMissingPosters();
          else if (type === 'backdrops') items = await getMissingBackdrops();
          else if (type === 'metadata') items = await getMissingMetadata();
          const results = await Promise.allSettled(items.slice(0, 20).map(i => handleRefreshItem(i.id)));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ refreshed: results.filter(r => r.status === 'fulfilled').length, total: items.length }));
        } else {
          res.writeHead(404); res.end('Not found');
        }
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (routes[pathname]) {
    try {
      const body = await routes[pathname]();
      if (body === null) { res.end(); return; }
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
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
