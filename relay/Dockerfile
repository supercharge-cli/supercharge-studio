# Supercharge Studio reference relay — ~50 MB image, no state except optional host bindings.
FROM node:22-alpine
WORKDIR /relay
COPY package.json server.mjs ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
ENV PORT=8080 RELAY_DATA=/data/bindings.json
RUN mkdir -p /data && chown node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
