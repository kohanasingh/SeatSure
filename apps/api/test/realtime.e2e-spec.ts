import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import { Socket as ClientSocket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { seatLockKey } from '../src/bookings/lock.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

// Phase 4 acceptance, scripted: two independent socket clients on one event —
// a booking made over HTTP must flip the seat for the *other* client within
// 1s, and a queued (contended) booking must resolve to CONFIRMED over the
// user's socket without any polling.

const RUN = randomUUID().slice(0, 8);

const waitFor = <T>(
  socket: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs: number,
): Promise<{ payload: T; elapsedMs: number }> => {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve({ payload, elapsedMs: Date.now() - startedAt });
    };
    socket.on(event, handler);
  });
};

describe('Realtime (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let baseUrl: string;
  let userToken: string;
  let userId: string;
  let adminToken: string;
  let eventId: string;
  let generalEventId: string;
  const sockets: ClientSocket[] = [];

  const connect = async (token?: string): Promise<ClientSocket> => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      auth: token ? { token } : {},
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    return socket;
  };

  const joinEvent = async (socket: ClientSocket, id: string): Promise<void> => {
    socket.emit('join-event', id);
    await new Promise((r) => setTimeout(r, 150)); // let the join settle server-side
  };

  const book = (body: Record<string, unknown>, token = userToken) =>
    request(baseUrl)
      .post('/trpc/bookings.create')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    await app.listen(0); // sockets need a real listening server
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    prisma = app.get(PrismaService);
    redis = app.get(REDIS_CLIENT);
    const tokens = app.get(TokenService);

    const user = await prisma.user.create({
      data: { email: `user-${RUN}@realtime-e2e.test`, passwordHash: 'x' },
    });
    userId = user.id;
    userToken = tokens.signAccessToken(user);
    const admin = await prisma.user.create({
      data: { email: `admin-${RUN}@realtime-e2e.test`, passwordHash: 'x', role: 'ADMIN' },
    });
    adminToken = tokens.signAccessToken(admin);

    const event = await prisma.event.create({
      data: {
        title: `realtime-e2e-${RUN}`,
        eventTime: new Date(Date.now() + 86_400_000),
        onSaleAt: new Date(Date.now() - 60_000),
        status: 'ON_SALE',
        seatingType: 'ASSIGNED',
        organizerId: userId,
        seats: {
          createMany: {
            data: Array.from({ length: 5 }, (_, i) => ({
              seatNumber: `A${i + 1}`,
              priceCents: 5_000,
            })),
          },
        },
      },
    });
    eventId = event.id;

    const general = await prisma.event.create({
      data: {
        title: `realtime-e2e-${RUN}-ga`,
        eventTime: new Date(Date.now() + 86_400_000),
        onSaleAt: new Date(Date.now() - 60_000),
        status: 'ON_SALE',
        seatingType: 'GENERAL',
        totalCapacity: 100,
        remainingCapacity: 100,
        gaPriceCents: 2_000,
        organizerId: userId,
      },
    });
    generalEventId = general.id;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    const events = await prisma.event.findMany({ where: { title: { startsWith: `realtime-e2e-${RUN}` } } });
    const eventIds = events.map((e) => e.id);
    await prisma.transaction.deleteMany({ where: { booking: { eventId: { in: eventIds } } } });
    await prisma.booking.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.seat.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@realtime-e2e.test' } } });
    await app.close();
  });

  it('flips the seat for a second client within 1s of a booking', async () => {
    const observer = await connect(); // unauthenticated — public availability
    await joinEvent(observer, eventId);
    const seat = await prisma.seat.findFirstOrThrow({
      where: { eventId, seatNumber: 'A1' },
    });

    const seatUpdated = waitFor<{ seatId: string; status: string }>(
      observer,
      'seat-updated',
      (p) => p.seatId === seat.id,
      5_000,
    );
    const res = await book({ kind: 'assigned', eventId, seatId: seat.id });
    expect(res.status).toBe(200);
    expect(res.body.result.data.status).toBe('CONFIRMED');

    const { payload, elapsedMs } = await seatUpdated;
    expect(payload.status).toBe('BOOKED');
    expect(elapsedMs).toBeLessThan(1_000); // the acceptance bar
  });

  it('emits capacity-updated to the event room on a GENERAL booking', async () => {
    const observer = await connect();
    await joinEvent(observer, generalEventId);

    const capacity = waitFor<{ eventId: string; remaining: number }>(
      observer,
      'capacity-updated',
      (p) => p.eventId === generalEventId,
      5_000,
    );
    await book({ kind: 'general', eventId: generalEventId, quantity: 3 }).expect(200);

    const { payload, elapsedMs } = await capacity;
    expect(payload.remaining).toBe(97);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('resolves an enqueued (contended) booking to CONFIRMED via booking-status, no refresh', async () => {
    const seat = await prisma.seat.findFirstOrThrow({
      where: { eventId, seatNumber: 'A2' },
    });
    const userSocket = await connect(userToken); // joins user:<id> room via handshake

    // simulate contention: an external holder owns the seat lock
    await redis.set(seatLockKey(seat.id), 'external-holder', 'PX', 2_500);

    const res = await book({ kind: 'assigned', eventId, seatId: seat.id });
    expect(res.status).toBe(200);
    expect(res.body.result.data.status).toBe('PENDING'); // Path B: 202-pending semantics
    const bookingId = res.body.result.data.id as string;

    // BullMQ retries with backoff; once the external lock expires the worker
    // confirms and pushes to the user room
    const { payload } = await waitFor<{ bookingId: string; status: string }>(
      userSocket,
      'booking-status',
      (p) => p.bookingId === bookingId,
      15_000,
    );
    expect(payload.status).toBe('CONFIRMED');

    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(stored.status).toBe('CONFIRMED');
    expect((await prisma.seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe('BOOKED');
  });

  it('admin.queueStats is ADMIN-only and reports queue counters', async () => {
    await request(baseUrl)
      .get('/trpc/admin.queueStats')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);

    const res = await request(baseUrl)
      .get('/trpc/admin.queueStats')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const stats = res.body.result.data as Record<string, number | null>;
    expect(stats).toMatchObject({
      waiting: expect.any(Number),
      active: expect.any(Number),
      completed: expect.any(Number),
      failed: expect.any(Number),
    });
    // the suite's own bookings ran through the queue → completed jobs exist
    expect(stats.completed).toBeGreaterThan(0);
  });
});
