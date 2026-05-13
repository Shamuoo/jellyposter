🎬 JellyPoster
A cinema-style home theater display and library management tool for Jellyfin. Shows what's currently playing on a dedicated screen, and provides a full suite of tools to manage and maintain your media library.

Note: This project was entirely AI-coded (Claude by Anthropic) as a personal home theater side project. Shared as-is — use it, fork it, break it.


Features
🎬 Now Playing

Full-screen movie poster with blurred backdrop
Title, tagline, genre, runtime, age rating
Quality badges — 4K, 1080p, 720p, SD (uses width for widescreen accuracy)
3D detection — 1080p 3D, 4K 3D etc (detects HSBS, SBS, MVC filenames)
Audio badges — Atmos, DTS:X, TrueHD, DTS-HD MA, DD+, DD, AAC etc
Version badges — ×2 when multiple versions exist
Synopsis, director, cast
Community rating with star display
Live progress bar
Paused state — dims screen with ⏸ indicator
TV show support — series name + S01E01 format
Up Next card for TV episodes
Trailer QR code — scan to open YouTube trailer
Multi-room — shows all active Jellyfin sessions
Who's watching in top bar
← Back button to home screen
Cinematic sound effect on playback start

🏠 Home / Idle Screen

Logo, clock, date
Library stats — movies, shows, episodes
Weather widget — set your city in settings
🎲 Feeling Lucky — random movie, click to refresh
Continue Watching with progress bars
Recently Added
Most Popular (by community rating)
Watch History
On This Day — movies released today in history (TMDB, popular only)
Coming Soon (TMDB)
Customisable section order — drag to reorder in settings
Click any poster → full detail view

🔍 Search

Searches your entire Jellyfin library
Poster, year, genre, overview
Click result → detail view

🎞 Browse All Movies

Full library grid with infinite scroll
Sort by A–Z, Year, Rating, Date Added, Most Played
Filter by Genre
Quality + audio badges on every poster
Click any poster → detail view

🏷 Quality Badges & Version Grouping

Quality badges on every poster: 4K, 1080p, 720p, 3D (green), 480p
3D combined: 1080p 3D, 4K 3D
Duplicate movies grouped — all quality tags shown + ×2 version count
Detail view shows quality chips, audio, version count

🖼 Poster Detail View

Large poster, full overview, tagline
Complete cast with circular actor photos (from Jellyfin)
Director, rating stars, score
Quality + audio chips, version count
Release date, trailer QR code
Collapsible technical details (Jellyfin ID, quality, audio, versions)
⛶ Fullscreen toggle

🔧 Library Tools (v0.8)
Full library management page — 🔧 button bottom right.
Overview — health dashboard showing all issues at a glance
Quality Issues

SD / 480p movies
720p upgrade candidates
Poor audio (no surround sound)
Files with no media streams

Missing Content

Missing posters (with auto-fix button)
Missing backdrops
Missing overview / description

Versions & 3D

All multi-version movies
Your complete 3D library
2D-only movies (no 3D counterpart)

Music

Album and track counts
Albums missing artwork with fix buttons

Quick Actions

Scan all libraries
Fix all missing images (auto)
Refresh metadata per item
Full scan report

📡 Server Health
Health page with full Jellyfin diagnostics:

Latency with colour indicator
Server name, version, OS, architecture
Update available check (from Jellyfin)
GitHub release check — shows if JellyPoster is up to date
Active sessions with who's watching, progress, paused state
Transcoding details — direct/transcode, codec, bitrate
All libraries with paths
Connected devices count
Plugins list
Recent activity log with error/warning colouring

🌌 Screensaver

Cycles through recently added backdrops
Title, genre, synopsis overlay
Progress bar, tap to dismiss
Configurable delay

🔔 Notifications

Toast popup on new movie arrival
Confetti animation
Both toggleable

🔊 Sounds

UI click sounds
Cinematic tone on playback start
All toggleable

⚙ Settings Panel
⚙ button appears on mouse move (auto-hides). Four tabs:
TabOptionsStyleAccent colour, quality badge colour, title fontLayoutToggle every home section, drag to reorderDisplayScreensaver delay, auto-dim, 12hr clock, sounds, notificationsContentWeather city + units, trailer QR, up next, who's watching, multi-room, back button

Requirements

Docker
Jellyfin server on your network
TMDB API key (free) — for Coming Soon, On This Day, trailer QR codes


Setup
1. Get a Jellyfin API Key
Jellyfin → Dashboard → API Keys → +
2. Get a TMDB API Key (optional but recommended)
themoviedb.org → Settings → API → Request key (free)
3. Clone and build
bashcd /mnt/user/appdata
git clone https://github.com/Shamuoo/jellyposter.git
cd jellyposter
docker build -t jellyposter .
4. Run
bashdocker run -d \
  --name jellyposter \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /mnt/user/appdata/jellyposter/public:/app/public \
  -v /mnt/user/appdata/jellyposter/server:/app/server \
  -e JELLYFIN_URL="http://YOUR_JELLYFIN_IP:8096" \
  -e JELLYFIN_API_KEY="your_key" \
  -e TMDB_API_KEY="your_tmdb_key" \
  jellyposter
5. Open on your display
http://YOUR_SERVER_IP:3000

Updating
bashcd /mnt/user/appdata/jellyposter
git pull
docker restart jellyposter
Frontend changes (index.html) — refresh browser.
Backend changes (server/index.js) — docker restart jellyposter.

Display Options
DeviceHowAny browserhttp://server:3000 → F11 fullscreenRaspberry Pichromium-browser --kiosk http://server:3000Smart TVOpen browser and navigate
Pi kiosk autostart
ini# /etc/xdg/autostart/jellyposter.desktop
[Desktop Entry]
Type=Application
Name=JellyPoster
Exec=chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000

Environment Variables
VariableRequiredDescriptionJELLYFIN_URL✅Jellyfin URL e.g. http://192.168.1.10:8096JELLYFIN_API_KEY✅From Jellyfin Dashboard → API KeysTMDB_API_KEY⬜For Coming Soon, On This Day, trailer QRPORT⬜Port (default: 3000)POLL_INTERVAL_MS⬜Polling interval ms (default: 4000)

API Endpoints
EndpointDescription/api/now-playingCurrent playback/api/recently-addedLatest movies (deduped, quality tagged)/api/coming-soonUpcoming from TMDB/api/continue-watchingIn-progress items/api/popularHighest rated available movies/api/historyRecently watched/api/on-this-dayMovies released today in history/api/statsLibrary counts/api/randomRandom movie/api/new-arrivalsRecently detected new additions/api/search?q=queryLibrary search/api/all-moviesPaginated full library with filters/api/genresAll movie genres/api/weather?city=BrisbaneCurrent weather/api/server-healthFull server diagnostics + GitHub release/api/library/scanTrigger library scan/api/library/quality-reportQuality issue report/api/library/missing-contentMissing images/metadata report/api/library/versions-reportVersion and 3D report/api/library/music-reportMusic library report/api/library/refresh-metadata?id=Refresh item metadata/api/library/refresh-images?id=Refresh item images/api/person-image?id=Actor photo proxy/healthServer health check

Tech Stack

Backend: Node.js (zero npm dependencies — pure stdlib)
Frontend: Vanilla HTML/CSS/JS
Fonts: Google Fonts (Montserrat, Cormorant Garamond, Bebas Neue, Playfair Display, Inter)
APIs: Jellyfin REST API, TMDB API, wttr.in, GitHub API
Container: Docker


License
MIT — do whatever you want with it.
