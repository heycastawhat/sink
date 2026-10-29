# syntax=docker/dockerfile:1
# The server's dependencies and the web build are plain JavaScript, so they're built once on the build machine's
# own platform and copied into each architecture's image (no slow emulated installs for arm64).
FROM --platform=$BUILDPLATFORM oven/bun:1.3-slim AS deps
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM --platform=$BUILDPLATFORM oven/bun:1.3-slim AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM oven/bun:1.3-slim
WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /app/web/dist /app/web
COPY docker-entrypoint.sh /usr/local/bin/
ENV SINK_DATA_DIR=/data SINK_NOTES_DIR=/notes SINK_PLUGINS_DIR=/plugins SINK_PORT=8787 SINK_WEB_DIR=/app/web NODE_ENV=production
VOLUME ["/data", "/notes"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "src/index.ts"]
