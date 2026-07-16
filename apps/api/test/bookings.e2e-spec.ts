import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { seatLockKey } from '../src/bookings/lock.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import type Redis from 'ioredis';

// THE critical suite (BUILD_PHASES.md Phase 3): five concurrency scenarios
// against real Postgres + Redis. Must pass 3 consecutive runs.

const RUN = randomUUID().slice(0, 8);

interface BookingBody {
  id: string;
  status: string;
  failReason: string | null;
}

interface BookingResponse {
  httpStatus: number;
  booking?: BookingBody;
  errorMessage?: string;
}

describe('Bookings concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let userToken: string;
  let userId: string;
  let assignedEventId: string;

  const createUser = async (name: string): Promise<{ id: string; token: string }> => {
    const tokens = app.get(TokenService);
    const user = await prisma.user.create({
      data: { email: `${name}-${RUN}@bookings-e2e.test`, passwordHash: 'x' },
    });
    return { id: user.id, token: tokens.signAccessToken(user) };
  };

  const createAssignedEvent = async (
    seats: { seatNumber: string; priceCents: number }[],
  ): Promise<string> => {
    const event = await prisma.event.create({
      data: {
        title: `bookings-e2e-${RUN}`,
        eventTime: new Date(Date.now() + 86_400_000),
        onSaleAt: new Date(Date.now() - 60_000),
        status: 'ON_SALE',
        seatingType: 'ASSIGNED',
        organizerId: userId,
        seats: { createMany: { data: seats } },
      },
    });
    return event.id;
  };

  const createGeneralEvent = async (capacity: number, gaPriceCents: number): Promise<string> => {
    const event = await prisma.event.create({
      data: {
        title: `bookings-e2e-${RUN}-ga`,
        eventTime: new Date(Date.now() + 86_400_000),
        onSaleAt: new Date(Date.now() - 60_000),
        status: 'ON_SALE',
        seatingType: 'GENERAL',
        totalCapacity: capacity,
        remainingCapacity: capacity,
        gaPriceCents,
        organizerId: userId,
      },
    });
    return event.id;
  };

  const book = async (
    body: Record<string, unknown>,
    { token = userToken, idempotencyKey = randomUUID() } = {},
  ): Promise<BookingResponse> => {
    const res = await request(server)
      .post('/trpc/bookings.create')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body);
    if (res.status === 200) {
      return { httpStatus: res.status, booking: res.body.result.data as BookingBody };
    }
    return { httpStatus: res.status, errorMessage: res.body.error?.message as string };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    redis = app.get(REDIS_CLIENT);
    server = app.getHttpServer();

    const user = await createUser('main');
    userId = user.id;
    userToken = user.token;
    assignedEventId = await createAssignedEvent([
      ...Array.from({ length: 10 }, (_, i) => ({ seatNumber: `A${i + 1}`, priceCents: 5_000 })),
      { seatNumber: 'Z1', priceCents: 9_999 }, // amount ends in 99 → mock decline
      { seatNumber: 'Z2', priceCents: 5_000 }, // reserved for the lock-kill test
    ]);
  });

  afterAll(async () => {
    const events = await prisma.event.findMany({ where: { title: { startsWith: `bookings-e2e-${RUN}` } } });
    const eventIds = events.map((e) => e.id);
    await prisma.transaction.deleteMany({ where: { booking: { eventId: { in: eventIds } } } });
    await prisma.booking.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.seat.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@bookings-e2e.test' } } });
    await app.close();
  });

  const seatByNumber = async (seatNumber: string) => {
    const seat = await prisma.seat.findFirst({ where: { eventId: assignedEventId, seatNumber } });
    expect(seat).not.toBeNull();
    return seat!;
  };

  it('1. 100 parallel bookings for the SAME seat → exactly 1 CONFIRMED, 99 SEAT_TAKEN', async () => {
    const seat = await seatByNumber('A1');

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        book({ kind: 'assigned', eventId: assignedEventId, seatId: seat.id }),
      ),
    );

    const confirmed = results.filter((r) => r.booking?.status === 'CONFIRMED');
    const seatTaken = results.filter((r) => r.errorMessage === 'SEAT_TAKEN');
    expect(confirmed).toHaveLength(1);
    expect(seatTaken).toHaveLength(99);

    // ground truth in the DB: one confirmed booking, seat BOOKED, txn recorded
    const dbConfirmed = await prisma.booking.count({
      where: { seatId: seat.id, status: 'CONFIRMED' },
    });
    expect(dbConfirmed).toBe(1);
    expect((await seatByNumber('A1')).status).toBe('BOOKED');
    expect(
      await prisma.transaction.count({ where: { bookingId: confirmed[0]!.booking!.id } }),
    ).toBe(1);
  });

  it('2. 200 parallel GENERAL bookings vs capacity 50 → exactly 50 CONFIRMED, remaining 0, never negative', async () => {
    const eventId = await createGeneralEvent(50, 2_500);

    const results = await Promise.all(
      Array.from({ length: 200 }, () => book({ kind: 'general', eventId, quantity: 1 })),
    );

    const confirmed = results.filter((r) => r.booking?.status === 'CONFIRMED');
    const soldOut = results.filter((r) => r.errorMessage === 'SOLD_OUT');
    expect(confirmed).toHaveLength(50);
    expect(soldOut).toHaveLength(150);

    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.remainingCapacity).toBe(0);
    expect(event.remainingCapacity).toBeGreaterThanOrEqual(0);
    expect(await prisma.booking.count({ where: { eventId, status: 'CONFIRMED' } })).toBe(50);
  });

  it('3. same idempotency key sent 10× in parallel → 1 booking, same ID returned 10×', async () => {
    const eventId = await createGeneralEvent(100, 3_000);
    const idempotencyKey = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        book({ kind: 'general', eventId, quantity: 2 }, { idempotencyKey }),
      ),
    );

    expect(results.every((r) => r.httpStatus === 200)).toBe(true);
    const ids = new Set(results.map((r) => r.booking!.id));
    expect(ids.size).toBe(1);

    expect(await prisma.booking.count({ where: { eventId } })).toBe(1);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.remainingCapacity).toBe(98); // exactly one qty-2 decrement
  });

  it('4. payment failure (amount ending 99) → booking FAILED, seat still AVAILABLE, no transaction row', async () => {
    const seat = await seatByNumber('Z1'); // priceCents 9999

    const result = await book({ kind: 'assigned', eventId: assignedEventId, seatId: seat.id });

    expect(result.httpStatus).toBe(200);
    expect(result.booking!.status).toBe('FAILED');
    expect(result.booking!.failReason).toBe('card_declined');

    expect((await seatByNumber('Z1')).status).toBe('AVAILABLE');
    expect(await prisma.transaction.count({ where: { bookingId: result.booking!.id } })).toBe(0);
    // and the failure is recorded for polling
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: result.booking!.id } });
    expect(stored.status).toBe('FAILED');
  });

  it('5. lock killed mid-flight → version check still prevents double booking', async () => {
    const seat = await seatByNumber('Z2');
    const second = await createUser('second');

    // slow the first booking down so it is still inside its transaction
    // (payment step) when we steal the lock
    process.env.SIMULATE_PAYMENT_LATENCY_MS = '1500';
    try {
      const first = book({ kind: 'assigned', eventId: assignedEventId, seatId: seat.id });
      await sleep(500); // first request has the lock and is mid-transaction

      await redis.del(seatLockKey(seat.id)); // kill the lock out from under it

      process.env.SIMULATE_PAYMENT_LATENCY_MS = '0';
      // second request now acquires the lock freely — layers 2+3 must stop it
      const second_result = await book(
        { kind: 'assigned', eventId: assignedEventId, seatId: seat.id },
        { token: second.token },
      );
      const first_result = await first;

      const outcomes = [first_result, second_result];
      expect(outcomes.filter((r) => r.booking?.status === 'CONFIRMED')).toHaveLength(1);
      expect(outcomes.filter((r) => r.errorMessage === 'SEAT_TAKEN')).toHaveLength(1);

      expect(
        await prisma.booking.count({ where: { seatId: seat.id, status: 'CONFIRMED' } }),
      ).toBe(1);
      expect((await seatByNumber('Z2')).status).toBe('BOOKED');
    } finally {
      process.env.SIMULATE_PAYMENT_LATENCY_MS = '0';
    }
  });
});
