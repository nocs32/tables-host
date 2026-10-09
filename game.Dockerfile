# syntax=docker/dockerfile:1
#
# One image per game. Every game repo has the same layout (pnpm workspace with modules/web,
# core-api, protocol and engine), so this file builds any of them: the build context is the
# game's checkout under games/, and SCOPE is its package scope (wild-table → @wild-table/*).
#
# The image runs core-api. It also carries the built web app in /web, which the Caddy image
# copies out at build time (see caddy/Dockerfile).

FROM node:24.20.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# The repo's `packageManager` field picks the pnpm version.
RUN corepack enable
WORKDIR /app

# Install everything and build the web app.
FROM base AS build
ARG SCOPE
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm --filter "@${SCOPE}/web" build

# Only core-api and the workspace packages it uses. tsx is a dev dependency, so dev deps stay.
FROM base AS runtime
ARG SCOPE
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@${SCOPE}/core-api..."
COPY --from=build /app/modules/web/dist /web

ENV NODE_ENV=production \
    CORE_API_PORT=3000
EXPOSE 3000
USER node
WORKDIR /app/modules/core-api
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# One process (no pnpm wrapper), so `docker stop` reaches the server directly.
CMD ["node", "--import", "tsx", "src/index.ts"]
