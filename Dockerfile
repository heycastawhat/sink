# syntax=docker/dockerfile:1
FROM oven/bun:1.3-slim AS deps
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-slim AS web
WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM oven/bun:1.3-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY --from=web /app/web/dist /app/web
ENV SINK_DATA_DIR=/data SINK_PORT=8787 SINK_WEB_DIR=/app/web NODE_ENV=production
VOLUME /data
EXPOSE 8787
USER bun
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/index.ts"]
