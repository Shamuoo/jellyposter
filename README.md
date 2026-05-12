# 🎬 JellyPoster

A cinema-style "Now Playing" display for your Jellyfin home theater setup. Shows what's currently playing on a dedicated screen — think lobby display for your home cinema.

> **Note:** This project was entirely AI-coded (Claude by Anthropic) as a personal home theater project. It's shared as-is for anyone who finds it useful.

---

## Features

### Now Playing Screen
- Full-screen movie poster with blurred backdrop
- Movie title, tagline, genre, runtime, age rating, quality (4K/1080p etc)
- Synopsis, director, and cast
- Community rating with star display
- Live progress bar with current / total time
- Paused state indicator
- TV show support — series name, season and episode number
- "Up Next" card for TV episodes
- Trailer QR code (scan with phone to open YouTube)
- Multi-room display — shows all active Jellyfin sessions
- Who's watching shown in top bar
- Back button to return to home screen

### Idle / Home Screen
- 🎬 Logo + clock + date
- Library stats — total movies, shows, and episodes
- Weather widget (set your city in settings)
- 🎲 Feeling Lucky — random movie suggestion, click to refresh
- **Continue Watching** row with progress bars
- **Recently Added** movies row
- **Most Popular** movies row
- **Coming Soon** row (powered by TMDB)
- Click any poster for a full detail view — cast, director, overview, trailer QR, rating

### Screensaver
- Cycles through recently added movie posters fullscreen
- Shows title, genre, and synopsis
- Configurable delay
- Tap/click to dismiss

### Settings Panel
- ⚙ button appears on mouse move (auto-hides)
- **Style tab** — accent colour, quality badge colour, title font picker
- **Layout tab** — toggle every home screen section on/off individually
- **Display tab** — screensaver on/off + delay, auto-dim timer, 12hr clock toggle
- **Content tab** — weather city + units, trailer QR, up next, who's watching, multi-room, back button
- Settings persist in browser localStorage

---

## Requirements

- Docker
- Jellyfin server on your network
- TMDB API key (free) for Coming Soon and trailer data

---

## Setup

### 1. Get a Jellyfin API Key
Jellyfin → Dashboard → API Keys → **+**

### 2. Get a TMDB API Key (optional but recommended)
Sign up free at [themoviedb.org](https://www.themoviedb.org) → Settings → API → Request API key

### 3. Clone and build
```bash
cd /mnt/user/appdata
git clone https://github.com/Shamuoo/jellyposter.git
cd jellyposter
docker build -t jellyposter .
```

### 4. Run
```bash
docker run -d \
  --name jellyposter \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /mnt/user/appdata/jellyposter/public:/app/public \
  -v /mnt/user/appdata/jellyposter/server:/app/server \
  -e JELLYFIN_URL="http://YOUR_JELLYFIN_IP:8096" \
  -e JELLYFIN_API_KEY="your_jellyfin_key" \
  -e TMDB_API_KEY="your_tmdb_key" \
  jellyposter
```

### 5. Open on your display
```
http://YOUR_SERVER_IP:3000
```

---

## Updating

```bash
cd /mnt/user/appdata/jellyposter
git pull
docker restart jellyposter
```

Frontend changes (`index.html`) take effect on browser refresh.  
Backend changes (`server/index.js`) require `docker restart jellyposter`.

---

## Display Options

| Device | How to open |
|---|---|
| Any browser | Navigate to `http://your-server:3000` and press F11 |
| Raspberry Pi | `chromium-browser --kiosk http://your-server:3000` |
| Smart TV | Open browser and navigate to the URL |
| Spare PC/Mac | Open Chrome/Firefox fullscreen |

### Raspberry Pi kiosk autostart
```ini
# /etc/xdg/autostart/jellyposter.desktop
[Desktop Entry]
Type=Application
Name=JellyPoster
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JELLYFIN_URL` | Yes | Your Jellyfin server URL e.g. `http://192.168.1.10:8096` |
| `JELLYFIN_API_KEY` | Yes | Jellyfin API key from Dashboard → API Keys |
| `TMDB_API_KEY` | No | TMDB key for Coming Soon + trailer QR codes |
| `PORT` | No | Port to serve on (default: 3000) |
| `POLL_INTERVAL_MS` | No | How often to poll Jellyfin in ms (default: 4000) |

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/now-playing` | Current playback session |
| `GET /api/recently-added` | Latest movies added to library |
| `GET /api/coming-soon` | Upcoming movies from TMDB |
| `GET /api/continue-watching` | In-progress items |
| `GET /api/popular` | Most played movies |
| `GET /api/stats` | Library counts |
| `GET /api/random` | Random movie suggestion |
| `GET /api/weather?city=Brisbane` | Current weather |
| `GET /health` | Server health check |

---

## Tech Stack

- **Backend:** Node.js (no dependencies — pure stdlib)
- **Frontend:** Vanilla HTML/CSS/JS
- **Fonts:** Google Fonts (Montserrat, Cormorant Garamond, Bebas Neue, Playfair Display)
- **APIs:** Jellyfin REST API, TMDB API, wttr.in (weather)
- **Containerised:** Docker

---

## License

MIT — do whatever you want with it.
