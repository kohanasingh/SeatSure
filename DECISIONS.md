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

## Phase 3

- **Seat lock is the Redlock single-instance primitive implemented directly** (`SET NX PX`
  + token-checked Lua release), not the `redlock` npm package: the package is a years-old
  beta whose `exports` map ships no TypeScript types under `nodenext` resolution, and with
  a single Redis node the library's multi-node quorum adds nothing. The algorithm's
  correctness properties for one node are identical. Fail-fast (no retries): a held lock
  answers SEAT_TAKEN immediately in Phase 3; Phase 4 turns that branch into the enqueue
  path.
- **Idempotency keys claim atomically via `SET NX GET`** (Redis ≥ 7): the value is the
  booking id, written *before* processing, so N parallel duplicates elect one winner and
  the losers wait for that booking row and return the same id. If processing fails without
  creating a booking row (SEAT_TAKEN, SOLD_OUT, …) the key is deleted so an honest retry
  isn't bricked for 24 h; a payment decline *does* persist (FAILED row) and stays mapped.
- **Payment decline → FAILED booking row is written outside the rolled-back transaction**,
  giving the client something to poll (`bookings.getStatus`) while guaranteeing seat /
  capacity / transaction-row state is untouched (test 4 asserts all three).
- **`bookings.create` returns HTTP 200 with `status: FAILED`** on payment decline rather
  than an error: the spec's error list (SEAT_TAKEN, SOLD_OUT, EVENT_NOT_ON_SALE,
  RATE_LIMITED) doesn't include payment failure, and the booking row is the durable record
  of that outcome.
- **`paymentMethod` is picked deterministically from the booking id hash** (mock provider
  has no real instrument); `deviceFingerprint` = sha256(user-agent | accept-language |
  x-screen-hint header), null when no components are present.
- **`timeToCompleteMs` added as an optional field on `createBookingSchema`** (client-
  reported, fraud signal only) — the spec places it on the transactions row but gave it no
  transport; the input schema is the natural carrier.
- **Booking rate limit (10/15min/user) deferred to Phase 5** where BUILD_PHASES.md lists
  it under hardening.

## Phase 4

- **The queued path returns HTTP 200 with `status: PENDING`**, not a literal 202: tRPC
  does not expose per-procedure status codes. The response body carries the spec's
  `{ bookingId, status: 'pending' }` semantics; clients branch on the status field.
- **Concurrency test 1 updated for Path B semantics**: lock losers now enqueue instead of
  failing fast, so "99 SEAT_TAKEN" became "99 rejected" — immediate SEAT_TAKEN or PENDING
  that terminally FAILs (`SEAT_TAKEN`, or `RETRIES_EXHAUSTED` when three lock-contended
  attempts all bounced). The invariant that matters is unchanged and still asserted:
  exactly one CONFIRMED booking, ever.
- **`BULLMQ_PREFIX` env** namespaces all BullMQ keys. The e2e suite sets `bull-e2e` so its
  in-process workers never race a running dev server's workers over the same Redis —
  without it, a dev worker could steal a test job and emit socket events on the wrong
  server.
- **Checkout is two routes**: `/checkout?eventId&seatId|qty` hosts the mock payment form
  (payment runs inside `bookings.create` in v1, so the form must precede the call; the
  form's mount-to-submit time is the `timeToCompleteMs` fraud signal), then
  `router.replace` to the spec's `/checkout/[bookingId]` which resolves pending →
  confirmed via the booking-status socket push with a 2s `bookings.getStatus` poll as
  fallback.
- **Socket auth callback re-reads the in-memory token per connection attempt**; login/
  logout forces a reconnect so the server-side `user:<id>` room membership always matches
  the session. Gateway CORS reflects the request origin for now — pinned to WEB_ORIGIN in
  Phase 5 hardening.
- **`send-confirmation` jobs keep `removeOnComplete: {count: 1000}`** so
  `admin.queueStats` can compute avgMs from recent completed jobs.

## Phase 5

- **tRPC is registered as Nest module middleware** (TrpcModule `configure()`),
  not `app.use('/trpc', …)` in bootstrap: raw pre-init mounting placed it ahead of
  nestjs-pino's pino-http, so `/trpc` requests were never logged and carried no
  request id (and post-init mounting lands behind Nest's 404 catch-all). Nest strips
  the matched prefix exactly like an Express mount, which the tRPC adapter expects.
- **Env config is Zod-validated at boot** (`validate:` on ConfigModule) — the last
  unvalidated boundary from the "Zod at every boundary" audit; REST bodies (pipes),
  tRPC inputs (procedure schemas), and socket messages (uuid checks) already were.
- **Booking rate limit lives in BookingsService.create** (not a guard): tRPC
  procedures don't pass through Nest guards. Shared sliding-window logic moved to
  `RateLimitService`; the /auth guard consumes the same service. `RATE_LIMITED` maps
  to tRPC `TOO_MANY_REQUESTS`.
- **Load runs raise `RATE_LIMIT_BOOKING_MAX`**: 10 attempts/15min/user is a fraud
  control; the k6 scenario deliberately exceeds it thousands of times per user.
  Documented in README; the control stays on in normal operation and tests keep the
  code path active.
- **k6 treats 409 as an expected status** (`http.expectedStatuses(200, 409)`):
  under deliberate contention SEAT_TAKEN is the correct answer, not a failure —
  otherwise `http_req_failed<1%` is unsatisfiable by design.
- **Gateway CORS reads `process.env.WEB_ORIGIN` at import time** (decorator
  evaluates before ConfigModule loads .env): in prod the variable exists in the real
  environment; the dev fallback equals the dev default. Load-test fixes (connection
  pool, advisory pre-read, VU jitter) are recorded in README's "what broke" section.

## Phase 6

- **"<200MB runtime images" read as compressed (registry) size**: the mandated
  `node:20-alpine` base alone is ~122MB uncompressed, so an uncompressed target is
  unreachable with the Nest+Prisma stack. Measured: api 78MB / web 64MB compressed
  (api ~253MB, web ~176MB uncompressed). Pruned from the api bundle: the Prisma CLI
  peer chain that pnpm `auto-install-peers` drags into `pnpm deploy --prod` output
  (~100MB: engines, effect, typescript, fast-check) and `@prisma/client`'s
  per-database WASM engine variants (~50MB; the native library engine is used).
- **`npx prisma@^6 generate` is version-pinned in the Dockerfile** — bare `npx
  prisma` resolves to Prisma 7, which rejects v6 schemas (`url` in datasource).
- **Migrations run as a one-off compose service** built from the image's `builder`
  stage (`migrate` → `service_completed_successfully` gate), never from the serving
  container; on Cloud Run the same step becomes a release job. The prod compose file
  sets `name: seatsure-prod` so `down` can never remove the dev stack's containers
  (same service names, same directory — learned the hard way).
- **Same-origin prod routing**: web is built with `NEXT_PUBLIC_API_URL=""` (relative
  fetches through nginx), SSR uses runtime `API_URL_INTERNAL=http://api:3001`; nginx
  proxies `/auth`, `/trpc`, `/webhooks`, `/socket.io` (websocket upgrade, no rate
  limit on the socket path) to the API and everything else to Next.
- **CI runs the Vitest e2e suites against service containers; Playwright is a local
  acceptance step** (the CI acceptance list is lint → typecheck → test → build
  images; the browser flow needs a running full stack and stays in the quickstart).
- **Cloud Run flags matter for this architecture**: `min-instances 1` +
  `no-cpu-throttling` because the BullMQ worker and delayed on-sale jobs execute
  between requests; `session-affinity` for Socket.io.
- **`RATE_LIMIT_AUTH_MAX` relaxed in the local `.env`** (1000): the web app's silent
  refresh fires on every page load, so the strict 10/15min default trips during
  normal dev and Playwright runs. `.env.example` keeps the strict default.

## Phase 7 (deployment readiness hardening)

- **BullMQ cross-spec-file leak, audited and confirmed already closed.** The Phase 4
  entry above flagged the risk: a leftover `Worker` from one e2e spec file's Nest
  app could stay subscribed to the shared `bull-e2e` queue after that file's suite
  ends and pick up a job enqueued by the next file, whose gateway has since torn
  down — an emit on a closed Socket.io server. Audit: `BookingsWorker` and
  `OnSaleWorker` both implement `onApplicationShutdown` and call `worker.close()`
  (`bookings.worker.ts`, `on-sale.worker.ts`); every e2e spec's `afterAll` calls
  `app.close()`; Nest's `close()` unconditionally runs `callDestroyHook()` →
  `callShutdownHook()` regardless of `enableShutdownHooks()` (verified against the
  installed `@nestjs/core` — that flag only wires OS signal listeners, not `close()`
  itself); `vitest.config.ts` has `fileParallelism: false`, so one file's `afterAll`
  always completes before the next file's `beforeAll` starts. No missing hook, no
  fix needed there. Added `BULLMQ_PREFIX: bull-ci` to `ci.yml`'s env block anyway,
  as defense-in-depth parity for any BullMQ-touching script run directly in that
  shell — `vitest.config.ts`'s `test.env` already forces `bull-e2e` for the suite
  process itself regardless of the outer shell env.
- **Fixed-delay waits replaced with poll/ack patterns in the e2e suites**, since a
  constant tuned against a fast local machine isn't guaranteed sufficient on a
  slower/CPU-constrained CI runner (a bigger constant just moves the flake
  threshold, it doesn't remove it). `realtime.e2e-spec.ts`'s `joinEvent` used to
  `emit('join-event', id)` then sleep 150ms and hope; `join-event` now returns an
  ack (`onJoinEvent` in `realtime.gateway.ts` returns `boolean`) and the test
  helper resolves on that ack instead. `bookings.e2e-spec.ts` concurrency test 5
  used to sleep 500ms and assume the first request had reached the payment step;
  it now polls Redis for the actual lock key to exist. Concurrency test 1's
  PENDING-drain check already used `expect.poll` — left as-is, no fix needed.
- **Real bug found while replacing test 5's fixed sleep, not the hypothesized CI-speed
  flake**: polling for the lock key timed out on every run — `SIMULATE_PAYMENT_LATENCY_MS`
  set by the test at runtime was never reaching `MockPaymentProvider`. `ConfigService.get()`
  resolves against the Zod-validated boot-time snapshot (`getFromValidatedEnv`, checked
  before `getFromProcessEnv` — confirmed in `@nestjs/config`'s source) added by the Phase 5
  "env is Zod-validated at boot" change, so a `process.env` mutation after boot silently
  never took effect. The old 500ms-sleep version of this test had been passing anyway
  since Phase 5 by accident: without the intended delay, the first booking completes and
  releases the lock before the sleep even ends, so `redis.del` on the (already-gone) lock
  is a no-op and the second booking hits the ordinary `SEAT_TAKEN` path — same pass/fail
  shape as the intended stolen-lock race, but never actually exercising layers 2+3.
  Fixed by reading `process.env.SIMULATE_PAYMENT_LATENCY_MS` directly in
  `mock-payment.provider.ts` instead of through `ConfigService`, matching the file's
  existing (until now incorrect) comment that this value is meant to be runtime-mutable
  by tests.
- **Redis-down surfaces as 503, not a generic 500.** `maxRetriesPerRequest: 2`
  (`redis.module.ts`) already makes ioredis fail fast instead of hanging, but nothing
  translated that thrown error into a meaningful response. Added `isRedisUnavailableError`
  (`redis/redis-errors.util.ts`) — true for `MaxRetriesPerRequestError`/`AbortError` or a
  connection-level errno (`ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`EPIPE`), false for
  application-level Redis errors (which should still surface as-is). Wired into
  `LockService.acquireSeatLock`/`release`, `RateLimitService.consume`, and the bookings
  idempotency `SET NX GET` claim — all rethrow `TRPCError({code:'SERVICE_UNAVAILABLE'})`.
  `RateLimitService` is shared by a tRPC call site (`BookingsService.create`) and a REST
  guard (`AuthRateLimitGuard`); rather than adding a second transport-specific error type,
  `AuthRateLimitGuard` catches the `TRPCError` `RateLimitService` throws (it's just a plain
  `Error` subclass with a `.code`, nothing tRPC-transport-specific about catching it) and
  re-throws `ServiceUnavailableException`, since a raw `TRPCError` thrown from a Nest guard
  wouldn't otherwise be translated into an HTTP response. Covered by
  `test/redis-unavailable.e2e-spec.ts`: two tests, each booting an isolated Nest app with
  `REDIS_CLIENT` overridden to a client pointed at an address nothing listens on, asserting
  `bookings.create` and `/auth/register` both return 503.
- **Ported forward a real, evidenced fix from the earlier `ci-fix` branch that
  `fix/deployment-readiness` (branched off `main`) didn't have**: tests 1 and 2 fire
  100-200 truly parallel requests, and supertest/superagent defaults to `agent: false`
  (a fresh one-off socket per request), which was enough to exhaust fds/ephemeral ports
  on GitHub's constrained runners — observed as ECONNRESET in an actual CI run
  (29529500313), not a hypothesized failure. Fix: a shared keep-alive `http.Agent`
  (`maxSockets: 256`) reused across `bookings.e2e-spec.ts`'s `book()` calls, destroyed in
  `afterAll`.
