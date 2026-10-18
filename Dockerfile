# syntax=docker/dockerfile:1.7
# Build the service from compiled output. Bundled mode copies the index in;
# fetched mode leaves it out and sets POSTCODE_INDEX to a URL at runtime.
#
#   docker build -t postcode-service .
#   docker build -t postcode-service --build-arg BUNDLE_INDEX=1 .   # requires packages/service/data/postcodes.idx

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages/index-format/package.json packages/index-format/
COPY packages/indexer/package.json packages/indexer/
COPY packages/service/package.json packages/service/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm --filter @postcode/index-format --filter @postcode/service run build \
 && pnpm --filter @postcode/service deploy --prod --legacy /deploy

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    POSTCODE_INDEX=/app/data/postcodes.idx
WORKDIR /app
COPY --from=build /deploy /app
# Optional bundled index. The directory always exists so a bind mount works in fetched mode.
ARG BUNDLE_INDEX=0
COPY --chown=node:node packages/service/data* /app/data/
RUN if [ "$BUNDLE_INDEX" = "0" ]; then rm -f /app/data/*.idx; fi && mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1
# The index lives off-heap, so a modest heap is enough.
CMD ["node", "--max-old-space-size=128", "dist/server.js"]
