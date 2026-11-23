FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node config/config.example.json ./config/config.example.json
RUN mkdir -p /app/config && chown -R node:node /app
USER node
EXPOSE 17356
VOLUME ["/app/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:17356/healthz || exit 1
CMD ["node", "src/server.mjs"]
