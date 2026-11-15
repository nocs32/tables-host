# syntax=docker/dockerfile:1
#
# The notes vault as an MCP server for claude.ai (see src/server.ts). Node 24 runs the TypeScript as it is,
# so there is no build step. Runs as uid 1000 (the image's `node` user, the same id as the Pi's admin), so
# the notes it writes in ~/vault stay the Pi user's.

FROM node:24.18.0-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

USER node
ENV NODE_ENV=production VAULT_DIR=/vault PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/server.ts"]
