import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';

// Prepares the k6 spike scenario (BUILD_PHASES.md Phase 5): one ASSIGNED
// event with a 400-seat pool and enough users+tokens for 500 VUs. Rerunnable:
// wipes previous load-test rows first. Output: load/loadtest-data.json
// (gitignored — it contains bearer tokens).

const prisma = new PrismaClient();

const EVENT_TITLE = 'k6 Booking Spike';
const USER_DOMAIN = 'load.test';
const USERS = 600;
const ROWS = 20;
const SEATS_PER_ROW = 20; // 20 × 20 = the 400-seat pool

async function wipePrevious(): Promise<void> {
  const events = await prisma.event.findMany({ where: { title: EVENT_TITLE } });
  const eventIds = events.map((e) => e.id);
  await prisma.transaction.deleteMany({ where: { booking: { eventId: { in: eventIds } } } });
  await prisma.booking.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.seat.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `@${USER_DOMAIN}` } } });
}

async function main(): Promise<void> {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error('JWT_ACCESS_SECRET missing — run from apps/api with .env');
  const jwt = new JwtService({ secret, signOptions: { expiresIn: '2h' } });

  await wipePrevious();

  const organizer = await prisma.user.findFirstOrThrow({ where: { role: 'ORGANIZER' } });
  const event = await prisma.event.create({
    data: {
      title: EVENT_TITLE,
      description: 'Load-test pool — safe to delete',
      eventTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      onSaleAt: new Date(Date.now() - 60_000),
      status: 'ON_SALE',
      seatingType: 'ASSIGNED',
      organizerId: organizer.id,
      seats: {
        createMany: {
          data: Array.from({ length: ROWS }, (_, row) =>
            Array.from({ length: SEATS_PER_ROW }, (_, n) => ({
              seatNumber: `${String.fromCharCode(65 + row)}${n + 1}`,
              priceCents: 5_000, // never ends in 99 — payments must succeed
            })),
          ).flat(),
        },
      },
    },
  });
  const seats = await prisma.seat.findMany({ where: { eventId: event.id }, select: { id: true } });

  await prisma.user.createMany({
    data: Array.from({ length: USERS }, (_, i) => ({
      email: `loadtest-${i}@${USER_DOMAIN}`,
      passwordHash: 'x', // never logged in with — tokens are pre-signed
    })),
  });
  const users = await prisma.user.findMany({ where: { email: { endsWith: `@${USER_DOMAIN}` } } });
  const tokens = users.map((u) => jwt.sign({ sub: u.id, email: u.email, role: u.role }));

  const outDir = join(__dirname, '..', '..', '..', 'load');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'loadtest-data.json'),
    JSON.stringify({ eventId: event.id, seats: seats.map((s) => s.id), tokens }),
  );

  console.log(`Load seed ready: event ${event.id}, ${seats.length} seats, ${tokens.length} tokens`);
  console.log('Wrote load/loadtest-data.json');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
