# Build from the repo root:  docker build -f apps/web/Dockerfile .
# NEXT_PUBLIC_API_URL is baked at build time; empty string = same origin
# (nginx proxies API paths). SSR uses runtime API_URL_INTERNAL instead.

FROM node:20-alpine AS builder
RUN corepack enable
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @seatsure/web...

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @seatsure/shared build \
  && pnpm --filter @seatsure/api exec prisma generate \
  && pnpm --filter @seatsure/web build

FROM node:20-alpine AS runner
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
RUN addgroup -S seatsure && adduser -S seatsure -G seatsure
# Next standalone output keeps the monorepo layout under the output dir
COPY --from=builder --chown=seatsure:seatsure /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=seatsure:seatsure /repo/apps/web/.next/static ./apps/web/.next/static
USER seatsure
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
