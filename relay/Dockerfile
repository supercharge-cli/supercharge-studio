# Supercharge Studio relay: a blind, end-to-end encrypted pipe between phones and computers.
# Small (node:22-alpine + ws), runs as an unprivileged user, read-only root filesystem friendly.
FROM node:22-alpine AS deps
WORKDIR /relay
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine
LABEL org.opencontainers.image.title="Supercharge Studio relay" \
      org.opencontainers.image.description="Self-hostable public relay for Supercharge Studio mobile pairing. End-to-end encrypted; the relay sees only opaque frames." \
      org.opencontainers.image.source="https://github.com/supercharge-cli/supercharge-studio" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /relay
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 RELAY_DATA=/data/bindings.json
COPY --from=deps /relay/node_modules ./node_modules
COPY package.json server.mjs ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/healthz || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
