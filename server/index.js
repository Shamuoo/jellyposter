const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const JELLYFIN_URL = (process.env.JELLYFIN_URL || 'http://localhost:8096').replace(/\/$/, '');
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '4000', 10);

if (!JELLYFIN_API_KEY) console.warn('[warn] JELLYFIN_API_KEY not set');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

function jellyfinGet(endpoint) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${JELLYFIN_URL}${endpoint}`;
    const parsed = new url.URL(fullUrl);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'X-Emby-Authorization': `MediaBrowser Token="${JELLYFIN_API_KEY}"`,
        'Accept': 'application/json',
      },
      timeout: 5000,
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

function posterUrl(itemId) {
  return `${JELLYFIN_URL}/Items/${itemId}/Images/Primary?maxWidth=600&api_key=${JELLYFIN_API_KEY}`;
}
function backdropUrl(itemId) {
  return `${JELLYFIN_URL}/Items/${itemId}/Images/Backdrop/0?maxWidth=1920&api_key=${JELLYFIN_API_KEY}`;
}

let cache = null;
let lastFetch = 0;

async function getNowPlaying() {
  const now = Date.now();
  if (now - lastFetch < POLL_INTERVAL_MS) return cache;

  try {
    const sessions = await jellyfinGet('/Sessions');
    lastFetch = now;

    const playing = sessions.find(s =>
      s.NowPlayingItem &&
      s.PlayState &&
      !s.PlayState.IsPaused &&
      ['Movie', 'Episode', 'Video'].includes(s.NowPlayingItem.Type)
    );

    if (!playing) { cache = null; return null; }

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

    cache = {
      item: fullItem,
      positionTicks: playState.PositionTicks || 0,
      runtimeTicks: fullItem.RunTimeTicks || 0,
      isPaused: playState.IsPaused || false,
      sessionUser: playing.UserName || '',
    };

    return cache;
  } catch (e) {
    console.error('[error]', e.message);
    return cache;
  }
}

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

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', jellyfin: JELLYFIN_URL }));
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
  console.log(`   Jellyfin: ${JELLYFIN_URL}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
