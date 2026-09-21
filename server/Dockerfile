# voicigame server with ffmpeg (for video conversion and dub exports).
FROM node:22-alpine
LABEL app=voicigame
RUN apk add --no-cache ffmpeg && mkdir /data /stats && chown node:node /data /stats
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data STATS_DIR=/stats
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
