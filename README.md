# 🎬 JellyPoster

THIS IS COMPLETELY AI-CODED- I MADE THIS FOR MYSELF. BUGS AND ISSUES ARE EXPECTED

Cinema-style "Now Playing" display for your Jellyfin home theater setup.

Shows: movie poster, title, tagline, genre, runtime, age rating, synopsis, community rating, and a live progress bar.

---

## Setup

### 1. Get a Jellyfin API Key
Jellyfin → Dashboard → API Keys → **+**

### 2. Build the image
```bash
cd /mnt/user/appdata/jellyposter
docker build -t jellyposter .
```

### 3. Run
```bash
docker run -d \
  --name jellyposter \
  --restart unless-stopped \
  -p 3000:3000 \
  -e JELLYFIN_URL="http://YOUR_JELLYFIN_IP:8096" \
  -e JELLYFIN_API_KEY="YOUR_KEY_HERE" \
  jellyposter
```

### 4. Open the display
Navigate any browser to `http://YOUR_UNRAID_IP:3000`

---

## Updating

```bash
cd /mnt/user/appdata/jellyposter
git pull
docker rm -f jellyposter
docker build -t jellyposter .
docker run -d \
  --name jellyposter \
  --restart unless-stopped \
  -p 3000:3000 \
  -e JELLYFIN_URL="http://YOUR_JELLYFIN_IP:8096" \
  -e JELLYFIN_API_KEY="YOUR_KEY_HERE" \
  jellyposter
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `JELLYFIN_URL` | `http://localhost:8096` | Jellyfin server URL |
| `JELLYFIN_API_KEY` | *(required)* | Jellyfin API key |
| `PORT` | `3000` | Port to serve on |
| `POLL_INTERVAL_MS` | `4000` | How often to check Jellyfin (ms) |

---

## Kiosk mode (Raspberry Pi / spare PC)

```bash
chromium-browser --kiosk http://localhost:3000
```
