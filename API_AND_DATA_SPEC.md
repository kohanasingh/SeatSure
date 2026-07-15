# API_AND_DATA_SPEC.md — SeatSure Contracts

## 1. Prisma schema (authoritative)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ORGANIZER
  ADMIN
}

enum SeatingType {
  ASSIGNED
  GENERAL
}

enum EventStatus {
  DRAFT
  ON_SALE
  SOLD_OUT
  ENDED
}

enum SeatStatus {
  AVAILABLE
  BOOKED
}

enum BookingStatus {
  PENDING
  CONFIRMED
  FAILED
  CANCELLED
}

model User {
  id            String    @id @default(uuid())
  email         String    @unique
  passwordHash  String
  role          Role      @default(USER)
  createdAt     DateTime  @default(now())
  bookings      Booking[]
  transactions  Transaction[]
  refreshTokens RefreshToken[]
}

model RefreshToken {
  id         String   @id @default(uuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  tokenHash  String   @unique
  familyId   String   // rotation family, for reuse detection
  expiresAt  DateTime
  revokedAt  DateTime?
  createdAt  DateTime @default(now())

  @@index([userId])
  @@index([familyId])
}

model Event {
  id                String      @id @default(uuid())
  title             String
  description       String?
  venue             String?
  eventTime         DateTime
  onSaleAt          DateTime
  status            EventStatus @default(DRAFT)
  seatingType       SeatingType
  // GENERAL admission only:
  totalCapacity     Int?
  remainingCapacity Int?
  gaPriceCents      Int?
  // ASSIGNED only: capacity derived from seats
  organizerId       String
  createdAt         DateTime    @default(now())
  seats             Seat[]
  bookings          Booking[]

  @@index([status, onSaleAt])
}

model Seat {
  id         String     @id @default(uuid())
  eventId    String
  event      Event      @relation(fields: [eventId], references: [id])
  seatNumber String     // e.g. "A12"
  priceCents Int
  status     SeatStatus @default(AVAILABLE)
  version    Int        @default(0) // optimistic locking
  bookings   Booking[]

  @@unique([eventId, seatNumber])
  @@index([eventId, status])
}

model Booking {
  id          String        @id @default(uuid())
  userId      String
  user        User          @relation(fields: [userId], references: [id])
  eventId     String
  event       Event         @relation(fields: [eventId], references: [id])
  seatId      String?       // null for GENERAL
  seat        Seat?         @relation(fields: [seatId], references: [id])
  quantity    Int           @default(1) // >1 only for GENERAL
  status      BookingStatus @default(PENDING)
  failReason  String?
  createdAt   DateTime      @default(now())
  confirmedAt DateTime?
  transaction Transaction?

  @@index([userId])
  @@index([eventId, status])
}
```

Plus a raw migration (Prisma can't express partial unique indexes in schema):

```sql
-- The last line of defense: DB physically cannot hold two confirmed
-- bookings for one seat.
CREATE UNIQUE INDEX one_confirmed_booking_per_seat
  ON "Booking"("seatId")
  WHERE status = 'CONFIRMED' AND "seatId" IS NOT NULL;
```

```prisma
model Transaction {
  id                  String   @id @default(uuid())
  userId              String
  user                User     @relation(fields: [userId], references: [id])
  bookingId           String   @unique
  booking             Booking  @relation(fields: [bookingId], references: [id])
  amountCents         Int
  currency            String   @default("INR")
  paymentMethod       String   // credit_card | debit_card | upi | wallet (mock picks one)
  paymentProviderRef  String   // mock provider's charge id
  ipAddress           String?
  deviceFingerprint   String?  // sha256(user-agent + accept-language + screen hint header)
  userAgent           String?
  bookingAttemptCount Int      @default(1) // attempts by this user for this event in last 24h
  timeToCompleteMs    Int?     // client-reported form completion time
  isFirstBooking      Boolean
  accountAgeDays      Int
  createdAt           DateTime @default(now())
  isFraud             Boolean  @default(false) // label column for the fraud ML project

  @@index([userId, createdAt])
}
```

Money is integer cents/paise everywhere. Never floats, never DECIMAL in app code.

## 2. Shared Zod schemas (packages/shared)

Define once, use in web forms, tRPC inputs, and NestJS pipes:
`registerSchema`, `loginSchema`, `createEventSchema` (discriminated union on seatingType), `createBookingSchema` (discriminated union: `{ kind:'assigned', seatId }` | `{ kind:'general', quantity: 1-8 }`), `eventQuerySchema` (pagination: cursor + limit ≤ 50).

## 3. REST endpoints (NestJS controllers)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /auth/register | — | 201 → sets refresh cookie, returns { accessToken, user } |
| POST | /auth/login | — | same shape; 401 generic message (no user-enumeration) |
| POST | /auth/refresh | refresh cookie | rotates; reuse of rotated token revokes family |
| POST | /auth/logout | refresh cookie | revokes token, clears cookie |
| POST | /webhooks/payments | provider signature | mock provider posts here in async mode (Phase 5 stretch); MUST be idempotent |
| GET | /health, /ready | — | liveness / readiness |

Rate limits (Redis-backed): /auth/* 10 req / 15 min / IP. Booking create: 10 req / 15 min / user.

## 4. tRPC router (apps/api, consumed by apps/web)

```
events.list          input: eventQuerySchema        → paginated events (cached)
events.byId          input: { id }                   → event detail
events.seatMap       input: { eventId }              → seats[] (NEVER cached)
bookings.create      input: createBookingSchema + Idempotency-Key header
                     → 200 { booking } (direct path)
                     → 202 { bookingId, status:'pending' } (queued path)
                     errors: SEAT_TAKEN, SOLD_OUT, EVENT_NOT_ON_SALE, RATE_LIMITED
bookings.getStatus   input: { bookingId }            → { status, failReason? }
bookings.myBookings  input: pagination               → user's bookings
admin.createEvent    ORGANIZER+  input: createEventSchema (+ seatLayout for ASSIGNED)
admin.updateEvent    ORGANIZER+  (busts cache)
admin.queueStats     ADMIN       → { waiting, active, completed, failed, avgMs }
```

All protected procedures read the access JWT from the Authorization header via tRPC context.

## 5. PaymentProvider interface (the Stripe seam)

```ts
export interface ChargeRequest {
  userId: string;
  bookingId: string;
  amountCents: number;   // computed server-side from DB prices — never from client
  currency: string;
  idempotencyKey: string;
}

export interface ChargeResult {
  ok: boolean;
  providerRef: string;   // charge id
  failureCode?: 'card_declined' | 'insufficient_funds' | 'provider_error';
}

export interface PaymentProvider {
  charge(req: ChargeRequest): Promise<ChargeResult>;
}
```

**MockPaymentProvider (v1):**
- Succeeds by default with `providerRef = 'mock_' + nanoid()`.
- Deterministic failure hooks for testing: amountCents ending in 99 → `card_declined`; a `SIMULATE_PAYMENT_LATENCY_MS` env adds delay.
- Registered via NestJS DI token `PAYMENT_PROVIDER` so `StripePaymentProvider` later is a one-line module swap.
- README must note the v1 simplification (charge inside the DB transaction) and the planned Stripe saga refactor (pending → charge → confirm/release with webhook confirmation).

## 6. Socket.io contract

Handshake: `auth: { token: <accessJWT> }` — verified in middleware; unauthenticated sockets may still join `event:<id>` rooms (public availability data) but never `user:<id>` rooms.

| Event | Payload | Room |
|---|---|---|
| seat-updated | { seatId, status } | event:<eventId> |
| capacity-updated | { eventId, remaining } | event:<eventId> |
| booking-status | { bookingId, status, failReason? } | user:<userId> |

## 7. Frontend pages (apps/web)

- `/` — event list (SSR, from cached events.list)
- `/events/[id]` — detail. ASSIGNED: seat grid (green available / gray booked), live socket updates. GENERAL: quantity stepper + remaining count.
- `/checkout/[bookingId]` — mock payment form (captures timeToCompleteMs), then pending → confirmed via socket
- `/bookings` — my bookings
- `/login`, `/register`
- `/organizer` — create/manage events (role-gated), simple queue-stats card for ADMIN

Keep UI minimal-clean with shadcn defaults. No custom design work.

## 8. Environment variables (.env.example must list all)

DATABASE_URL, REDIS_URL, JWT_ACCESS_SECRET, JWT_ACCESS_TTL=15m, REFRESH_TTL_DAYS=7, WEB_ORIGIN, API_PORT=3001, NODE_ENV, SIMULATE_PAYMENT_LATENCY_MS=0, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD
