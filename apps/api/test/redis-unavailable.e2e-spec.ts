import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/redis/redis.constants';

// Real Postgres, but REDIS_CLIENT is overridden per test with a client
// pointed at an address nothing listens on — proves a down Redis surfaces
// as 503 SERVICE_UNAVAILABLE (lock.service.ts / rate-limit.service.ts /
// the bookings idempotency claim) rather than a generic 500.

const RUN = randomUUID().slice(0, 8);

const brokenRedisApp = async (): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useFactory({ factory: () => new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 2 }) })
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
};

describe('Redis unavailable (e2e)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('booking create returns 503 (not 500) when Redis is unreachable', async () => {
    app = await brokenRedisApp();
    const prisma = app.get(PrismaService);
    const tokens = app.get(TokenService);

    const user = await prisma.user.create({
      data: { email: `redis-down-${RUN}@e2e.test`, passwordHash: 'x' },
    });
    const token = tokens.signAccessToken(user);
    const event = await prisma.event.create({
      data: {
        title: `redis-down-${RUN}`,
        eventTime: new Date(Date.now() + 86_400_000),
        onSaleAt: new Date(Date.now() - 60_000),
        status: 'ON_SALE',
        seatingType: 'ASSIGNED',
        organizerId: user.id,
        seats: { createMany: { data: [{ seatNumber: 'A1', priceCents: 5_000 }] } },
      },
      include: { seats: true },
    });

    try {
      const res = await request(app.getHttpServer())
        .post('/trpc/bookings.create')
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'assigned', eventId: event.id, seatId: event.seats[0]!.id });

      expect(res.status).toBe(503);
    } finally {
      await prisma.seat.deleteMany({ where: { eventId: event.id } });
      await prisma.event.delete({ where: { id: event.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('auth rate-limit guard returns 503 (not 500) when Redis is unreachable', async () => {
    app = await brokenRedisApp();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: `redis-down-guard-${RUN}@e2e.test`, password: 'password123' });

    expect(res.status).toBe(503);

    const prisma = app.get(PrismaService);
    await prisma.user.deleteMany({ where: { email: `redis-down-guard-${RUN}@e2e.test` } });
  });
});
