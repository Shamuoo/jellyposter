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
if (!TMDB_API_KEY) console.warn('[warn] TMDB_API_KEY not set — coming soon will be unavailable');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

// ── Generic HTTP GET ──
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
        catch (e) { reject(new Error(`JSON parse error: ${body.slice(0, 200)}`)); }
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

function posterUrl(itemId) {
  return `${JELLYFIN_URL}/Items/${itemId}/Images/Primary?maxWidth=600&api_key=${JELLYFIN_API_KEY}`;
}
function backdropUrl(itemId) {
  return `${JELLYFIN_URL}/Items/${itemId}/Images/Backdrop/0?maxWidth=1920&api_key=${JELLYFIN_API_KEY}`;
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

    const playing = sessions.find(s =>
      s.NowPlayingItem &&
      s.PlayState &&
      !s.PlayState.IsPaused &&
      ['Movie', 'Episode', 'Video'].includes(s.NowPlayingItem.Type)
    );

    if (!playing) { nowPlayingCache = null; return null; }

    const item = playing.NowPlayingItem;
    const playState = playing.PlayState;

    let fullItem = item;
    try {
      fullItem = await jellyfinGet(`/Items/${item.Id}?fields=Overview,Taglines,Genres,OfficialRating,CommunityRating,People,MediaStreams`);
    } catch (e) {
      console.warn('[warn] Could not fetch full item:', e.message);
    }

    fullItem.posterUrl = posterUrl(item.Id);
    fullItem.backdropUrl = backdropUrl(item.Id);
    fullItem.RunTimeTicks = fullItem.RunTimeTicks || item.RunTimeTicks;

    nowPlayingCache = {
      item: fullItem,
      positionTicks: playState.PositionTicks || 0,
      runtimeTicks: fullItem.RunTimeTicks || 0,
      isPaused: playState.IsPaused || false,
      sessionUser: playing.UserName || '',
    };

    return nowPlayingCache;
  } catch (e) {
    console.error('[error] getNowPlaying:', e.message);
    return nowPlayingCache;
  }
}

// ── Recently Added ──
let recentlyAddedCache = null;
let recentlyAddedLastFetch = 0;
const RECENTLY_ADDED_TTL = 5 * 60 * 1000; // 5 minutes

async function getRecentlyAdded() {
  const now = Date.now();
  if (recentlyAddedCache && now - recentlyAddedLastFetch < RECENTLY_ADDED_TTL) return recentlyAddedCache;

  try {
    const data = await jellyfinGet('/Items/Latest?MediaType=Video&IncludeItemTypes=Movie&Limit=10&fields=Overview,Genres,ProductionYear,OfficialRating,CommunityRating');
    recentlyAddedLastFetch = now;
    recentlyAddedCache = (data || []).map(item => ({
      id: item.Id,
      title: item.Name,
      year: item.ProductionYear,
      genre: (item.Genres || []).slice(0, 2).join(' / '),
      rating: item.OfficialRating,
      score: item.CommunityRating,
      overview: item.Overview,
      posterUrl: posterUrl(item.Id),
    }));
    return recentlyAddedCache;
  } catch (e) {
    console.error('[error] getRecentlyAdded:', e.message);
    return recentlyAddedCache || [];
  }
}

// ── Coming Soon (TMDB) ──
let comingSoonCache = null;
let comingSoonLastFetch = 0;
const COMING_SOON_TTL = 60 * 60 * 1000; // 1 hour

async function getComingSoon() {
  if (!TMDB_API_KEY) return [];
  const now = Date.now();
  if (comingSoonCache && now - comingSoonLastFetch < COMING_SOON_TTL) return comingSoonCache;

  try {
    const data = await httpGet(`https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_API_KEY}&language=en-US&page=1`);
    comingSoonLastFetch = now;
    const results = (data.results || []).slice(0, 10);
    comingSoonCache = results.map(m => ({
      id: m.id,
      title: m.title,
      year: m.release_date ? m.release_date.split('-')[0] : null,
      releaseDate: m.release_date,
      overview: m.overview,
      score: m.vote_average,
      posterUrl: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    }));
    return comingSoonCache;
  } catch (e) {
    console.error('[error] getComingSoon:', e.message);
    return comingSoonCache || [];
  }
}

// ── Static file server ──
const PUBLIC_DIR = path.resolve('/app/public');

const server = http.createServer(async (req, res) => {
  const pathname = url.parse(req.url).pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/api/now-playing') {
    try {
      const data = await getNowPlaying();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data || null));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/recently-added') {
    try {
      const data = await getRecentlyAdded();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/coming-soon') {
    try {
      const data = await getComingSoon();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', jellyfin: JELLYFIN_URL, tmdb: !!TMDB_API_KEY }));
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
  console.log(`   TMDB: ${TMDB_API_KEY ? 'enabled' : 'disabled (set TMDB_API_KEY for coming soon)'}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
