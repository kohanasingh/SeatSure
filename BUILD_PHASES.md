# BUILD_PHASES.md — SeatSure Build Order

Each phase ends with acceptance checks. Run them, show results, commit, then proceed. Do not start a phase before the previous one passes.

## Phase 0 — Scaffold & local environment

- pnpm workspace: `apps/web`, `apps/api`, `packages/shared`
- TypeScript strict configs, ESLint + Prettier shared config
- docker-compose.yml: postgres:16 + redis:7-alpine (apps run on host via `pnpm dev` for hot reload)
- Prisma schema from API_AND_DATA_SPEC.md §1 + the partial-unique-index raw migration; initial migration applied
- `pnpm seed`: 3 events (1 GENERAL cap 500, 2 ASSIGNED with 10 rows × 20 seats), 20 users, 1 admin
- NestJS boots with /health and /ready; Next.js boots with a placeholder page

**Accept:** `docker compose up -d && pnpm db:migrate && pnpm seed && pnpm dev` gives a working stack; /ready returns 200 confirming Postgres + Redis connectivity; `pnpm typecheck` clean.

## Phase 1 — Auth

- Register / login / refresh (rotation + family-reuse revocation) / logout per ARCHITECTURE.md §7
- Passport JWT guard + roles guard; tRPC context reads the same token
- Redis-backed rate limiting on /auth/*
- Web: /login, /register pages; token stored in memory (never localStorage), silent refresh on 401

**Accept:** Vitest suite covering: successful register/login, wrong password 401, refresh rotation works, reused rotated token revokes family, USER blocked from ORGANIZER route. All passing.

## Phase 2 — Events & seat maps (read path)

- events.list (cursor-paginated, Redis-cached 60s), events.byId, events.seatMap (uncached)
- Cache busting on admin.createEvent / updateEvent
- admin.createEvent with seat-layout generation for ASSIGNED; on-sale delayed job flips DRAFT → ON_SALE
- Web: event list page (SSR), event detail with seat grid / quantity stepper

**Accept:** create an event with onSaleAt 30s in future → appears as DRAFT, auto-flips to ON_SALE, cache busts (verify list reflects it within one request). Seat map renders 200 seats.

## Phase 3 — Booking core (THE critical phase — do not rush)

- Booking service implementing the atomic transaction (ARCHITECTURE.md §3) for both seat models
- Redlock integration; optimistic version check; conditional decrement for GENERAL
- Idempotency-Key handling in Redis
- MockPaymentProvider behind PAYMENT_PROVIDER DI token; transactions row written with all fraud fields
- **Concurrency tests (Vitest, real Postgres + Redis via docker-compose):**
  1. 100 parallel `bookings.create` for the SAME assigned seat → exactly 1 CONFIRMED, 99 SEAT_TAKEN
  2. 200 parallel GENERAL bookings (qty 1) against capacity 50 → exactly 50 CONFIRMED, remainingCapacity 0, never negative
  3. Same idempotency key sent 10× in parallel → 1 booking, same ID returned 10×
  4. Payment failure (amount ending 99) → booking FAILED, seat still AVAILABLE, no transaction row
  5. Kill the lock mid-flight (release manually) → version check still prevents double booking

**Accept:** all five concurrency tests green, run 3× consecutively to rule out flakes.

## Phase 4 — Queue path & real-time

- BullMQ queue + worker (concurrency 10, 3 attempts, exponential backoff 1s)
- Contention path: failed lock acquisition → enqueue → 202 pending
- Socket.io gateway: rooms, JWT handshake middleware, the three events from spec §6
- Web: seat map flips live on seat-updated; checkout page resolves pending → confirmed via booking-status; polling fallback with bookings.getStatus
- admin.queueStats

**Accept:** open two browsers on the same event; booking in one flips the seat gray in the other within 1s. Enqueued booking resolves to confirmed via socket without refresh.

## Phase 5 — Hardening & load proof

- helmet, strict CORS, booking rate limit (10/15min/user), Zod validation audit at every boundary
- pino structured logging with request IDs through to the worker
- k6 script `load/booking-spike.js`: ramp 0→100 (30s), spike 500 (1m), ramp down (30s); thresholds http_req_failed<1%, p95<500ms; scenario books random seats from a pre-seeded pool of 400
- k6 script must end with a verification query: confirmed bookings == distinct booked seats, and == seats with status BOOKED. Print the numbers.
- Fix whatever breaks (likely: Prisma connection_limit, ioredis maxRetriesPerRequest, Node event-loop saturation)

**Accept:** k6 run passes thresholds; verification prints zero oversell; results table pasted into README.

## Phase 6 — Deploy artifacts & docs (write, do not deploy)

- Multi-stage Dockerfiles for web and api (node:20-alpine, non-root user, <200MB runtime images)
- nginx/nginx.conf (reverse proxy + limit_req 30r/m burst 20) and a docker-compose.prod.yml profile that runs the full prod-like stack locally
- .github/workflows/ci.yml: lint → typecheck → test → build images; deploy job gated behind `vars.DEPLOY_ENABLED`
- deploy/cloud-run.sh + vercel.json committed
- README: architecture diagram (Mermaid), quickstart, load-test results table, "how overselling is prevented" section (the 5 defense layers), Stripe-swap plan, and the three resume bullets
- One Playwright e2e: register → browse → book a GENERAL ticket → see it in /bookings
- DECISIONS.md finalized

**Accept:** `docker compose -f docker-compose.prod.yml up` serves the whole app through nginx on port 80; CI workflow passes on a clean clone; Playwright e2e green.
