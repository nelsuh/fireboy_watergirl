# Дөл ба Дусал — game page + authoritative realtime server. Built locally for
# linux/amd64 and shipped to the Usion game host (see ../game-host-guide.md).
# Runs on a read-only root as an unprivileged user.
FROM node:22-alpine
ENV NODE_ENV=production
# Keeps the heap well inside the container limit (usion.game.json memory_mb: 128).
ENV NODE_OPTIONS=--max-old-space-size=80
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY client ./client
COPY server ./server
RUN rm -rf client/test server/smoke.js
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD wget -q -T 3 -O /dev/null http://127.0.0.1:8080/health || exit 1
CMD ["node", "server/server.js"]
