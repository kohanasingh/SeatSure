# SeatSure

High-concurrency event ticketing — zero overselling, proven under load.

> Full README (architecture diagram, quickstart, deployment) lands in Phase 6.
> This file currently records the Phase 5 load-test results.

## Load test (k6 booking spike)

Scenario (`load/booking-spike.js`): ramp 0→100 VUs (30s), spike to 500 VUs (1m),
ramp down (30s). Every iteration books a random seat from a pre-seeded pool of
**400 seats** (`pnpm --filter @seatsure/api seed:load`), with jittered 1.5–3s
think-time. `409 SEAT_TAKEN` is an expected status under deliberate contention.

Environment: Windows 11, 12 logical cores; API (single Node process, in-process
BullMQ worker + Socket.io), Postgres 16 + Redis 7 in Docker Desktop, k6 v2.1.0
on the same machine. API run with `RATE_LIMIT_BOOKING_MAX` raised (the 10/15min
booking cap is a fraud control, not a capacity control) and stdout to a file.

### Results — 2026-07-17

| Metric | Threshold | Result |
|---|---|---|
| requests | — | 12,057 (≈99 rps sustained) |
| `http_req_failed` | < 1% | **0.00%** ✓ |
| `http_req_duration` p95 | < 500 ms | **102.28 ms** ✓ |
| `http_req_duration` median / avg / max | — | 16.9 ms / 29.9 ms / 199 ms |

### Zero-oversell verification (`pnpm --filter @seatsure/api verify:load`)

| Check | Count |
|---|---|
| confirmed bookings | **400** |
| distinct booked seats | **400** |
| seats with status BOOKED | **400** |
| transaction rows | **400** |
| pending bookings left | 0 |

**RESULT: ZERO OVERSELL ✓** — 12,057 spike attempts, exactly 400 seats sold,
one confirmed booking per seat, every confirmed booking has a payment record.

### What broke on the way (and the fixes)

1. **Prisma pool starvation** — default connection pool collapsed under 500
   concurrent transactional requests → `connection_limit=30&pool_timeout=30`
   on `DATABASE_URL`.
2. **No advisory pre-lock read** — after sell-out every request still took the
   seat lock and opened a transaction to learn `SEAT_TAKEN`. A cheap indexed
   pre-read (ARCHITECTURE.md §3.1) short-circuits sold seats; correctness still
   rests on the in-transaction re-read + guarded UPDATE.
3. **Middleware order bug** — the tRPC handler was mounted ahead of pino-http,
   so `/trpc` traffic was invisible to request logging and request-id
   propagation. Re-registered as Nest module middleware (after pino-http,
   before the 404 catch-all).
4. **Synchronized VU waves** — constant `sleep(2)` think-time bunched 500 VUs
   into thundering-herd waves that measured queue drain (~p95 1.1s), not
   service latency. Jittered think-time (1.5–3s) restored a realistic arrival
   process. Measured single-process capacity on this box: ~470 rps.
