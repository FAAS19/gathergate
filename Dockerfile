# syntax=docker/dockerfile:1

FROM node:24-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client ./
RUN npm run build

FROM node:24-alpine AS server-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:server && npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3080
ENV DATA_DIR=/data

RUN apk add --no-cache su-exec && mkdir -p /data && chown -R node:node /data /app

COPY --from=server-build --chown=node:node /app/node_modules ./node_modules
COPY --from=server-build --chown=node:node /app/dist ./dist
COPY --from=client-build --chown=node:node /app/client/dist ./client/dist
COPY --from=server-build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node skills ./skills
COPY --chown=node:node server.json ./server.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod 0755 /usr/local/bin/docker-entrypoint.sh

EXPOSE 3080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+((process.env.PORT||'').trim()||'3080')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
