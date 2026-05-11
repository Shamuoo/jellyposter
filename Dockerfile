FROM node:20-alpine

LABEL org.opencontainers.image.title="JellyPoster"
LABEL org.opencontainers.image.description="Cinema-style now playing display for Jellyfin"

WORKDIR /app

COPY server/ ./server/
COPY public/ ./public/

RUN addgroup -S jellyposter && adduser -S jellyposter -G jellyposter
USER jellyposter

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server/index.js"]
