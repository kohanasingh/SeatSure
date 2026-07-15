# ARCHITECTURE.md — SeatSure System Design

Reference document for Claude Code. Read fully before writing code.

## 1. Service topology

```
Browser (React 19 / Next.js 16)
   │  HTTPS
   ▼
nginx (reverse proxy, TLS termination, rate limit zone)   [prod only]
   │
   ├──►  apps/web   (Next.js — SSR pages, static assets)
   │        │ tRPC over HTTP
   ▼        ▼
apps/api  (NestJS — long-lived process)
   ├── REST controllers: /auth/*, /webhooks/*, /health
   ├── tRPC router: events, seats, bookings, admin
   ├── Socket.io gateway (same process, same port)
   ├── BullMQ worker (same process for v1; extract later if needed)
   │
   ├──► PostgreSQL 16 (Prisma) — source of truth
   └──► Redis 7 — cache, Redlock locks, BullMQ backing store,
                   rate-limit counters, idempotency keys
```

Why two apps: Next.js API routes are serverless-shaped (short-lived per request). BullMQ workers and Socket.io need a persistent process. NestJS is that process.

Why worker in-process for v1: simpler local dev and deploy. The worker is registered as a NestJS provider so extracting it to its own container later is a config change, not a rewrite.

## 2. The two booking paths

### Path A — direct booking (normal traffic)
1. Client POST booking (tRPC `bookings.create`) with Idempotency-Key.
2. API checks idempotency key in Redis → if seen, return the stored booking ID.
3. **ASSIGNED seats**: acquire Redlock on `lock:seat:<seatId>` (TTL 5000ms, no retries — fail fast).
   - Lock acquired → run the booking transaction (§3) → release lock in `finally`.
   - Lock not acquired → fall through to Path B (enqueue).
4. **GENERAL admission**: no lock; run atomic conditional decrement inside the transaction directly. Postgres row-level locking on the event row serializes concurrent decrements safely.
5. On success: emit `seat-updated` / `capacity-updated` on Socket.io room `event:<eventId>`, enqueue a `send-confirmation` job (mock email = log line).

### Path B — queued booking (contention / burst)
1. Job `process-booking` added to BullMQ queue `bookings` with `{ userId, seatId | qty, eventId, idempotencyKey }`, attempts 3, exponential backoff starting at 1000ms.
2. API immediately returns `202 { bookingId, status: 'pending' }` (a pending booking row is created first so the client has something to poll).
3. Worker (concurrency 10) executes the same booking service method as Path A.
4. Outcome pushed via Socket.io event `booking-status` to room `user:<userId>`; client also has `bookings.getStatus` to poll as fallback.
5. Terminal failure after 3 attempts → booking row set to `failed`, capacity/seat untouched (transaction never committed).

## 3. The booking transaction (the atomic core)

One Prisma `$transaction` containing, in order:
1. Re-read seat status / remaining capacity **inside** the transaction (the pre-lock read is advisory only).
2. ASSIGNED: `UPDATE seats SET status='booked', version=version+1 WHERE id=$1 AND status='available' AND version=$2` — 0 rows affected → throw `SeatConflictError` (transaction rolls back).
   GENERAL: `UPDATE events SET remaining_capacity = remaining_capacity - $qty WHERE id=$1 AND remaining_capacity >= $qty` — 0 rows → `SoldOutError`.
3. Insert `bookings` row (status `confirmed`).
4. Call `PaymentProvider.charge()` — **mock, synchronous, in-process** for v1, so it can live inside the transaction window. NOTE for Stripe later: real payment moves OUTSIDE the transaction into a saga (book-pending → charge → confirm/release). The `PaymentProvider` interface and booking service are structured so this refactor only touches the booking service, nothing else.
5. Insert `transactions` row with all fraud-relevant fields (see API_AND_DATA_SPEC.md §2, `transactions` table).

If anything throws, everything rolls back. There is no state where a seat is booked without a booking row, or a booking exists without a transaction record.

## 4. Concurrency defense layers (defense in depth)

| Layer | Mechanism | Catches |
|---|---|---|
| 1 | Redlock per-seat lock | Serializes the hot path, avoids stampede on Postgres |
| 2 | Optimistic version check in the UPDATE | Lock expiry edge case (process paused > TTL) |
| 3 | Conditional WHERE clause (status/capacity) | Any write that slipped past 1 and 2 |
| 4 | DB transaction isolation | Partial writes |
| 5 | Unique constraint: one confirmed booking per seat (partial unique index on bookings(seat_id) WHERE status='confirmed') | Absolute last line — the DB physically cannot store a double booking |

Layer 5 is mandatory. The k6 proof is "confirmed bookings == unique seats sold", and the schema itself should make violation impossible.

## 5. Caching strategy

- `events:list` — full event listing JSON, TTL 60s, busted on any event create/update.
- `event:<id>` — event detail, TTL 60s, busted on update.
- **Never cache seat availability.** Stale availability is dangerous; seat maps are read from Postgres and kept live via Socket.io pushes.
- Idempotency keys: `idem:<userId>:<key>` → bookingId, TTL 24h.
- Rate limits: sliding-window counters, `rl:<route>:<ip>`.

## 6. Real-time model

- Namespace: default. Rooms: `event:<eventId>` (joined on event detail page mount), `user:<userId>` (joined post-auth, socket handshake carries the access JWT, verified in a Socket.io middleware).
- Events emitted by server:
  - `seat-updated` `{ seatId, status }` → room `event:<id>`
  - `capacity-updated` `{ eventId, remaining }` → room `event:<id>`
  - `booking-status` `{ bookingId, status, reason? }` → room `user:<id>`
- Client never sends state-changing messages over the socket. All writes go through HTTP. Sockets are downstream-only.

## 7. Auth flow

1. Register: Zod-validate → bcrypt(12) hash → insert user → issue token pair.
2. Login: verify hash → issue access JWT (15 min, payload `{ sub, email, role }`) + refresh token (random 256-bit, stored hashed in `refresh_tokens` table, 7-day expiry, httpOnly + Secure + SameSite=Lax cookie).
3. Refresh: rotate — old token invalidated, new pair issued. Reuse of a rotated token → revoke the whole token family (theft detection).
4. Roles: `USER`, `ORGANIZER`, `ADMIN`. Guards on NestJS routes; role read from JWT claims.

## 8. Organizer flow (opening tickets for sale)

1. `admin.createEvent` (ORGANIZER/ADMIN only): inserts event with `status='draft'`, `on_sale_at` timestamp, and for ASSIGNED events bulk-inserts the seat rows (rows generated from a `{rows, seatsPerRow, price}` layout spec).
2. A BullMQ **delayed job** scheduled for `on_sale_at` flips `status='on_sale'` and busts the events cache. This is the "tickets drop at noon" mechanism.
3. Booking endpoint rejects any booking for events not `on_sale` (checked inside the transaction too).

## 9. Deployment shape (configs written in Phase 6, not deployed)

- `apps/web` → Vercel (`vercel.json` committed).
- `apps/api` → Docker multi-stage (node:20-alpine builder → slim runner), target Cloud Run; `deploy/cloud-run.sh` script committed.
- `nginx/nginx.conf` — reverse proxy config with `limit_req_zone` (30 r/m per IP on /api, burst 20) for the docker-compose "prod-like" profile.
- `.github/workflows/ci.yml` — lint → typecheck → test → build images on push to main; deploy steps present but gated behind a repo variable so they no-op until credentials exist.

## 10. Observability (minimum bar)

- Structured JSON logging (pino) with request IDs propagated web → api → worker.
- `/health` (liveness) and `/ready` (checks Postgres + Redis connectivity).
- BullMQ metrics: log queue depth and job duration; expose `admin.queueStats` tRPC endpoint for the admin dashboard page.
