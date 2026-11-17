FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc novnc websockify tini util-linux ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000 && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
RUN chmod +x scripts/entrypoint.sh && mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production DATA_DIR=/data CHROMIUM_PATH=/usr/bin/chromium
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/scripts/entrypoint.sh"]
