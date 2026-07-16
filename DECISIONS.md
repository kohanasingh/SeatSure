# DECISIONS.md — SeatSure

Ambiguities resolved during the build, per working-style rule: make the industry-standard
choice, note it here, continue.

## Phase 0

- **bcryptjs instead of native bcrypt.** Same algorithm and cost factor (12), pure-JS
  implementation. Avoids node-gyp native build headaches on the Windows dev machine and in
  alpine Docker images. The ~100–300 ms hash time is identical in spirit (it is the work
  factor, not the library, that provides the security margin).
- **Added one ORGANIZER seed user** (`organizer@seatsure.dev` / `password123`). The spec's
  seed list (20 users + 1 admin) has no organizer, but every Event requires an
  `organizerId` and the organizer flow (§8) is demoable only with an ORGANIZER-role user.
  Seeded events belong to this user. All seeded regular users share the password
  `password123`.
- **Initial migration generated offline** via `prisma migrate diff --from-empty --script`
  (no live DB needed), with the partial unique index
  (`one_confirmed_booking_per_seat`) appended to the same initial migration file, since
  Prisma's schema DSL cannot express partial indexes. `pnpm db:migrate` runs
  `prisma migrate deploy` (non-interactive, applies committed migrations).
- **Seeded events are created with `status=ON_SALE` and `onSaleAt` in the past** so the
  stack is demoable immediately after `pnpm seed` (per "everything demoable immediately").
  The DRAFT → ON_SALE delayed-job flow is exercised via `admin.createEvent` in Phase 2.
- **`packages/shared` is a built package** (tsc → CommonJS + d.ts in `dist/`), not a raw
  TS-source package. NestJS (CJS/tsc) and Next.js (bundler) both consume it without
  transpile hacks; `pnpm dev` runs `tsc --watch` for it alongside the two apps.
- **Toolchain versions:** Node 24, pnpm 9, NestJS 11, Prisma 6, Next.js 16, React 19,
  Tailwind 4, Zod 3.25.x (v3 API — broadest tRPC v11 compatibility).

## Phase 1

- **Refresh tokens hashed with sha256, not bcrypt.** The stored value protects against a
  DB leak; the input is a 256-bit random value, not a guessable password, so a fast hash
  is the correct tool (bcrypt's work factor buys nothing and costs ~200 ms per refresh).
- **Logout revokes the entire token family**, not only the presented token. The spec says
  "revokes token"; family revocation is the industry-standard interpretation (kill the
  session) and is strictly safer given rotation.
- **Refresh cookie is scoped `Path=/auth`** so it only travels on auth calls, never on
  booking/API traffic. `Secure` is enabled only when `NODE_ENV=production` (local dev is
  plain http).
- **Auth rate limit is env-tunable** (`RATE_LIMIT_AUTH_MAX`, default 10 per 15 min per IP,
  sliding-window ZSET per spec §5). The e2e suite raises it to 10000 instead of disabling
  the guard, so the limiter code path stays exercised in tests.
- **Added `GET /auth/me`** (not in the spec's endpoint table): the web app keeps the access
  token in memory only, so after a reload it restores the session via refresh + me; it also
  gives the Passport JWT guard a real protected REST route.
- **tRPC scaffolded in Phase 1** (spec assigns routers to Phase 2+) with `auth.me` and an
  ORGANIZER-gated `admin.ping`, because Phase 1 acceptance requires "USER blocked from
  ORGANIZER route" and all role-gated routes in the spec are tRPC procedures.
- **Vitest uses swc via `unplugin-swc`** (`oxc: false`): the default transform cannot emit
  `emitDecoratorMetadata`, which NestJS DI needs. Same reason `pnpm dev` uses `nest start`
  rather than tsx.

## Phase 2

- **`events.list` cache is keyed per page** (`events:list:<limit>:<cursor>`), since the
  spec's single "full event listing JSON" key doesn't compose with cursor pagination.
  Busting deletes the whole `events:list:` prefix via SCAN (never KEYS).
- **`events.list` returns all statuses, including DRAFT.** The acceptance scenario watches
  a DRAFT event flip to ON_SALE "in the list"; the booking layer (Phase 3) enforces
  ON_SALE, so listing drafts is harmless in this portfolio scope. A public/organizer list
  split can come later if needed.
- **Event DTOs serialize dates as ISO strings** so the Postgres path and the Redis-cache
  path return byte-identical shapes (no tRPC transformer configured).
- **`admin.updateEvent` edits only non-structural fields** (title, description, venue,
  eventTime, onSaleAt) — seatingType/layout/capacity are immutable after creation, since
  changing them would orphan or contradict generated seats. Organizers can only edit their
  own events (ADMIN can edit any). Changing `onSaleAt` on a DRAFT reschedules the flip job.
- **On-sale flip job**: BullMQ delayed job, `jobId = flip-on-sale-<eventId>` (BullMQ
  forbids `:` in custom ids) so an event never has two pending flips; the worker's
  `updateMany WHERE status='DRAFT'` guard makes duplicate/stale jobs no-ops.
- **Web imports the tRPC router type via `@seatsure/api/trpc` package export** (type-only,
  zero runtime coupling); web's tsconfig needs `experimentalDecorators` only so tsc can
  parse the imported API sources. `REDIS_CLIENT` token moved to `redis.constants.ts` to
  break a module↔provider import cycle this surfaced.
