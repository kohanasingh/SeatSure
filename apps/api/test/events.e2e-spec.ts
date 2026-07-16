import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { TokenService } from '../src/auth/token.service';
import { EventDto, EventListPage } from '../src/events/events.service';
import { PrismaService } from '../src/prisma/prisma.service';

// Real Postgres + Redis + in-process BullMQ worker: covers the Phase 2
// acceptance scenario with a short onSaleAt so the suite stays fast.

const RUN = randomUUID().slice(0, 8);
const TITLE = (name: string): string => `e2e-${RUN} ${name}`;

const trpcInput = (input: unknown): string => encodeURIComponent(JSON.stringify(input));

describe('Events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let organizerToken: string;
  let userToken: string;
  let organizerId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    const tokens = app.get(TokenService);
    const organizer = await prisma.user.create({
      data: { email: `organizer-${RUN}@e2e.test`, passwordHash: 'x', role: 'ORGANIZER' },
    });
    const user = await prisma.user.create({
      data: { email: `user-${RUN}@e2e.test`, passwordHash: 'x', role: 'USER' },
    });
    organizerId = organizer.id;
    organizerToken = tokens.signAccessToken(organizer);
    userToken = tokens.signAccessToken(user);
  });

  afterAll(async () => {
    const events = await prisma.event.findMany({ where: { organizerId } });
    const ids = events.map((e) => e.id);
    await prisma.seat.deleteMany({ where: { eventId: { in: ids } } });
    await prisma.event.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@e2e.test' } } });
    await app.close();
  });

  const createEvent = (body: Record<string, unknown>, token = organizerToken) =>
    request(server)
      .post('/trpc/admin.createEvent')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: TITLE('event'),
        eventTime: new Date(Date.now() + 86_400_000).toISOString(),
        onSaleAt: new Date(Date.now() + 3_000).toISOString(),
        ...body,
      });

  const getById = async (id: string): Promise<EventDto> => {
    const res = await request(server)
      .get(`/trpc/events.byId?input=${trpcInput({ id })}`)
      .expect(200);
    return res.body.result.data as EventDto;
  };

  const getList = async (): Promise<EventListPage> => {
    const res = await request(server)
      .get(`/trpc/events.list?input=${trpcInput({ limit: 50 })}`)
      .expect(200);
    return res.body.result.data as EventListPage;
  };

  it('blocks a plain USER from admin.createEvent', async () => {
    await createEvent(
      { seatingType: 'GENERAL', totalCapacity: 10, gaPriceCents: 1000 },
      userToken,
    ).expect(403);
  });

  it('creates a DRAFT event that auto-flips to ON_SALE and busts the list cache', async () => {
    const created = await createEvent({
      title: TITLE('flip'),
      seatingType: 'GENERAL',
      totalCapacity: 100,
      gaPriceCents: 2_500,
    }).expect(200);
    const event = created.body.result.data as EventDto;

    // appears as DRAFT — in byId and in the (now freshly cached) list
    expect(event.status).toBe('DRAFT');
    expect(event.remainingCapacity).toBe(100);
    expect((await getById(event.id)).status).toBe('DRAFT');
    const listBefore = await getList();
    expect(listBefore.items.find((e) => e.id === event.id)?.status).toBe('DRAFT');

    // the delayed job fires at onSaleAt (+3s)
    await expect
      .poll(async () => (await getById(event.id)).status, { timeout: 15_000, interval: 500 })
      .toBe('ON_SALE');

    // one request, no cache-TTL wait: the flip busted the DRAFT list entry
    const listAfter = await getList();
    expect(listAfter.items.find((e) => e.id === event.id)?.status).toBe('ON_SALE');
  });

  it('generates the seat map for an ASSIGNED event (rows × seatsPerRow, sorted)', async () => {
    const created = await createEvent({
      title: TITLE('seats'),
      seatingType: 'ASSIGNED',
      seatLayout: { rows: 3, seatsPerRow: 12, priceCents: 5_000 },
    }).expect(200);
    const event = created.body.result.data as EventDto;

    const res = await request(server)
      .get(`/trpc/events.seatMap?input=${trpcInput({ eventId: event.id })}`)
      .expect(200);
    const seats = res.body.result.data as { seatNumber: string; status: string }[];

    expect(seats).toHaveLength(36);
    expect(seats.every((s) => s.status === 'AVAILABLE')).toBe(true);
    // numeric sort within a row: A9 before A10, rows A → C
    expect(seats[0]?.seatNumber).toBe('A1');
    expect(seats[11]?.seatNumber).toBe('A12');
    expect(seats[12]?.seatNumber).toBe('B1');
    expect(seats[35]?.seatNumber).toBe('C12');
  });

  it('updateEvent edits fields, busts the cache, and enforces ownership', async () => {
    const created = await createEvent({
      title: TITLE('update'),
      seatingType: 'GENERAL',
      totalCapacity: 10,
      gaPriceCents: 1_000,
    }).expect(200);
    const event = created.body.result.data as EventDto;

    await getById(event.id); // prime the event:<id> cache

    await request(server)
      .post('/trpc/admin.updateEvent')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ id: event.id, title: TITLE('update-renamed') })
      .expect(200);

    // visible immediately despite the 60s TTL → cache was busted
    expect((await getById(event.id)).title).toBe(TITLE('update-renamed'));

    // a different (non-owner) organizer identity cannot edit it
    await request(server)
      .post('/trpc/admin.updateEvent')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ id: event.id, title: 'hijacked' })
      .expect(403);
  });
});
