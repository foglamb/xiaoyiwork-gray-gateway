# syntax=docker/dockerfile:1

# ---- panel build ----------------------------------------------------------
# The panel is a Vue SPA. It is compiled here so the runtime image needs no
# npm dependencies at all: the gateway itself ships zero runtime packages.
FROM node:24-alpine AS panel
WORKDIR /panel
COPY panel-ui/package.json panel-ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY panel-ui/ ./
# vite.config.js writes to ../src/panel; redirect into the build stage so nothing
# is written outside the working directory.
RUN npx vite build --outDir /panel/dist --emptyOutDir

# ---- runtime --------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    XIAOYI_PROXY_CONFIG=/app/config/config.json

WORKDIR /app

# wget is used by the healthcheck; tini gives a real PID 1 so SIGTERM reaches node.
RUN apk add --no-cache tini

COPY package.json ./
COPY src ./src
# Replace the checked-in bundle with the one built above. Removing first means a
# file dropped from the build cannot linger in the layer.
RUN rm -rf ./src/panel
COPY --from=panel /panel/dist ./src/panel
COPY config/config.example.json ./config/config.example.json
COPY docker/entrypoint.sh /usr/local/bin/xiaoyi-entrypoint

RUN chmod 0555 /usr/local/bin/xiaoyi-entrypoint \
 && mkdir -p /app/config \
 && chown -R node:node /app

USER node
EXPOSE 17356
VOLUME ["/app/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-17356}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/xiaoyi-entrypoint"]
CMD ["node", "src/cli.mjs", "--lan"]
