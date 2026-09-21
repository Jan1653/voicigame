# voicigame server with ffmpeg (for video conversion and dub exports).
# Built from the repository root (deploy/docker-compose.yml), so the mod files can go in for the mod's auto updater.
FROM node:22-alpine
LABEL app=voicigame
RUN apk add --no-cache ffmpeg && mkdir /data /stats && chown node:node /data /stats
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/src ./src
COPY server/public ./public
COPY mod/voicigame ./mod
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data STATS_DIR=/stats MOD_DIR=/app/mod
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
