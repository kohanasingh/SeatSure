# Build from the repo root:  docker build -f apps/api/Dockerfile .
# Multi-stage: workspace install + compile → pruned prod deployment.

FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /repo

# manifests first — dependency layer caches until a lockfile change
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @seatsure/api...

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @seatsure/shared build \
  && pnpm --filter @seatsure/api exec prisma generate \
  && pnpm --filter @seatsure/api build \
  # self-contained prod bundle (prod deps only, workspace links resolved)
  && pnpm --filter @seatsure/api deploy --prod /out \
  # regenerate the client inside the pruned bundle (pin the CLI to the
  # project's Prisma major — bare npx would grab v7, which rejects v6 schemas)
  && cd /out && npx --yes prisma@^6 generate \
  # prune what the runtime never touches: the Prisma CLI peer chain that
  # pnpm auto-install-peers dragged in (engines/effect/typescript/fast-check,
  # ~100MB) and @prisma/client's per-database WASM engine variants (~50MB —
  # we run the native library engine)
  && rm -rf node_modules/.pnpm/prisma@* \
            node_modules/.pnpm/@prisma+engines@* \
            node_modules/.pnpm/effect@* \
            node_modules/.pnpm/typescript@* \
            node_modules/.pnpm/fast-check@* \
            node_modules/prisma node_modules/typescript node_modules/.bin \
  && find node_modules/.pnpm -path '*@prisma/client/runtime/*' -name 'query_engine_bg.*' -delete

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S seatsure && adduser -S seatsure -G seatsure
COPY --from=builder --chown=seatsure:seatsure /out/node_modules ./node_modules
COPY --from=builder --chown=seatsure:seatsure /out/dist ./dist
COPY --from=builder --chown=seatsure:seatsure /out/prisma ./prisma
COPY --from=builder --chown=seatsure:seatsure /out/package.json ./
USER seatsure
EXPOSE 3001
CMD ["node", "dist/main.js"]
