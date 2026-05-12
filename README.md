# 🎬 JellyPoster

A cinema-style home theater display for Jellyfin. Shows what's currently playing on a dedicated screen — movie poster, metadata, cast, progress bar, and more. Designed to run on a TV, monitor, Raspberry Pi, or any browser on your network.

> **Note:** This project was entirely AI-coded (Claude by Anthropic) as a personal home theater side project. Shared as-is — use it, fork it, break it.


## Features

### 🎬 Now Playing
- Full-screen movie poster with blurred backdrop
- Title, tagline, genre, runtime, age rating, quality badge (4K / 1080p / 720p / 3D)
- Synopsis, director, cast
- Community rating with star display
- Live progress bar with elapsed / total time
- **Paused state** — dims screen with ⏸ indicator
- **TV show support** — series name + S01E01 format
- **Up Next** card for TV episodes
- **Trailer QR code** — scan with phone to open YouTube
- **Multi-room display** — shows all active Jellyfin sessions
- Who's watching shown in top bar
- Back button → returns to home screen
- Cinema sound effect when playback starts

### 🏠 Home / Idle Screen
- 🎬 Logo, clock, date
- **Library stats** — total movies, shows, episodes
- **Weather widget** — set your city in settings
- **🎲 Feeling Lucky** — random movie suggestion, click to refresh
- **Continue Watching** row with progress bars
- **Recently Added** row
- **Most Popular** row (only shows actually-played movies)
- **Watch History** row
- **On This Day** — movies released today in past years (TMDB, popular only)
- **Coming Soon** row (TMDB)
- Click any poster → full detail view

### 🔍 Search
- Search your entire Jellyfin library instantly
- Shows poster, year, genre, overview
- Click result → detail view

### 🎞 Browse All Movies
- Full library grid, 48 at a time with Load More
- Sort by: A–Z, Year, Rating, Date Added, Most Played
- Filter by Genre (auto-populated from your library)
- Ascending / Descending toggle
- Click any poster → detail view

### 🏷 Quality Badges & Version Grouping
- Every poster card shows quality badges: **4K**, **1080p**, **720p**, **3D**, **480p**
- Duplicate movies (same title/year in multiple versions) are grouped into one card
- Grouped cards show all available quality tags + a **×2** version count badge
- Detail view shows "2 versions available" chip

### 🖼 Poster Detail View
- Large poster, full overview, tagline
- Complete cast grid, director
- Rating stars + score
- Quality chips + version count
- Release date
- Trailer QR code (TMDB)

### 🌌 Screensaver
- Cycles through recently added movie backdrops fullscreen
- Shows title, genre, synopsis
- Progress bar per slide
- Tap to dismiss

### 🔔 Notifications
- Toast popup when a new movie is added to Jellyfin
- Confetti animation on new arrival
- Both toggleable in settings

### 🔊 Sounds
- Subtle UI click sounds
- Cinematic rising tone when playback starts
- All toggleable in settings

### ⚙ Settings Panel
Appears on mouse move (auto-hides). Four tabs:

| Tab | Options |
|---|---|
| **Style** | Accent colour, quality badge colour, title font |
| **Layout** | Toggle every home section on/off individually |
| **Display** | Screensaver delay, auto-dim timer, 12hr clock, sounds, notifications |
| **Content** | Weather city + units, trailer QR, up next, who's watching, multi-room, back button |

Settings persist in browser localStorage.

---

## Requirements

- Docker
- Jellyfin server on your network
- TMDB API key (free) — for Coming Soon, On This Day, trailer QR codes

---

## Setup

### 1. Get a Jellyfin API Key
Jellyfin → Dashboard → API Keys → **+**

### 2. Get a TMDB API Key *(optional but recommended)*
[themoviedb.org](https://www.themoviedb.org) → Settings → API → Request key (free)

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
  -e JELLYFIN_API_KEY="your_key" \
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
Backend changes (`server/index.js`) need `docker restart jellyposter`.

---

## Display Options

| Device | How |
|---|---|
| Any browser | Navigate to `http://server:3000` → F11 fullscreen |
| Raspberry Pi | `chromium-browser --kiosk http://server:3000` |
| Smart TV | Open browser and navigate |

### Pi kiosk autostart
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
| `JELLYFIN_URL` | ✅ | Jellyfin URL e.g. `http://192.168.1.10:8096` |
| `JELLYFIN_API_KEY` | ✅ | From Jellyfin Dashboard → API Keys |
| `TMDB_API_KEY` | ⬜ | For Coming Soon, On This Day, trailer QR |
| `PORT` | ⬜ | Port (default: 3000) |
| `POLL_INTERVAL_MS` | ⬜ | Polling interval in ms (default: 4000) |

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `/api/now-playing` | Current playback session |
| `/api/recently-added` | Latest movies (deduped) |
| `/api/coming-soon` | Upcoming from TMDB |
| `/api/continue-watching` | In-progress items |
| `/api/popular` | Most played movies |
| `/api/history` | Recently watched |
| `/api/on-this-day` | Movies released today in history |
| `/api/stats` | Library counts |
| `/api/random` | Random movie |
| `/api/new-arrivals` | Recently detected new additions |
| `/api/search?q=query` | Library search |
| `/api/all-movies` | Paginated full library with filters |
| `/api/genres` | All movie genres |
| `/api/weather?city=Brisbane` | Current weather |
| `/health` | Server health check |

---

## Tech Stack

- **Backend:** Node.js (zero npm dependencies — pure stdlib)
- **Frontend:** Vanilla HTML/CSS/JS
- **Fonts:** Google Fonts (Montserrat, Cormorant Garamond, Bebas Neue, Playfair Display, Inter)
- **APIs:** Jellyfin REST API, TMDB API, wttr.in
- **Containerised:** Docker

---

## License

MIT — do whatever you want with it.
