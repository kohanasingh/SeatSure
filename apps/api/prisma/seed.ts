import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

function rowLabel(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

async function main(): Promise<void> {
  // Wipe in FK-dependency order so the seed is rerunnable.
  await prisma.transaction.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.seat.deleteMany();
  await prisma.event.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@seatsure.dev';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin12345';

  const admin = await prisma.user.create({
    data: {
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, BCRYPT_COST),
      role: 'ADMIN',
    },
  });

  const organizer = await prisma.user.create({
    data: {
      email: 'organizer@seatsure.dev',
      passwordHash: await bcrypt.hash('password123', BCRYPT_COST),
      role: 'ORGANIZER',
    },
  });

  // 20 regular users, all with password "password123" (hash computed once).
  const userHash = await bcrypt.hash('password123', BCRYPT_COST);
  await prisma.user.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({
      email: `user${i + 1}@seatsure.dev`,
      passwordHash: userHash,
      role: 'USER' as const,
    })),
  });

  const now = Date.now();

  // 1 GENERAL admission event, capacity 500
  const ga = await prisma.event.create({
    data: {
      title: 'Summer Music Festival',
      description:  'A full day of live sets across three stages, food trucks, and a sunset headliner slot as the city\'s biggest open-air festival returns for another summer.',
      venue: 'Riverside Grounds',
      eventTime: new Date(now + 30 * DAY_MS),
      onSaleAt: new Date(now - 1 * DAY_MS),
      status: 'ON_SALE',
      seatingType: 'GENERAL',
      totalCapacity: 500,
      remainingCapacity: 500,
      gaPriceCents: 1_499_00,
      organizerId: organizer.id,
    },
  });

  // 2 ASSIGNED seating events, 10 rows x 20 seats = 200 seats each
  const assignedSpecs = [
    {
           title: 'Indie Rock Night',
      description:
        'Four up-and-coming indie acts share the bill for one late night at The Velvet Hall, closing with a full-band headline set.',
      venue: 'The Velvet Hall',
      eventTime: new Date(now + 14 * DAY_MS),
      maxSeatsPerOrder: 2, // restricted: max 2 seats per order
    },
    {
      title: 'Standup Comedy Gala',
      description:
        'A lineup of touring comedians for one night only, recorded live for an upcoming streaming special.',
      venue: 'Laugh Factory Arena',
      eventTime: new Date(now + 21 * DAY_MS),
      maxSeatsPerOrder: null, // unrestricted
    },
  ];

  const assignedEvents = [];
  for (const spec of assignedSpecs) {
    const event = await prisma.event.create({
      data: {
        ...spec,
        onSaleAt: new Date(now - 1 * DAY_MS),
        status: 'ON_SALE',
        seatingType: 'ASSIGNED',
        organizerId: organizer.id,
      },
    });

    const seats = [];
    for (let r = 0; r < 10; r++) {
      for (let s = 1; s <= 20; s++) {
        seats.push({
          eventId: event.id,
          seatNumber: `${rowLabel(r)}${s}`,
          // front rows (A) most expensive, back rows (J) cheapest
          priceCents: 2_000_00 - r * 100_00,
        });
      }
    }
    await prisma.seat.createMany({ data: seats });
    assignedEvents.push(event);
  }

  const counts = {
    users: await prisma.user.count(),
    events: await prisma.event.count(),
    seats: await prisma.seat.count(),
  };
  console.log('Seed complete:');
  console.log(`  users:  ${counts.users} (admin: ${admin.email}, organizer: ${organizer.email})`);
  console.log(`  events: ${counts.events} (GA "${ga.title}" cap 500 + 2 assigned)`);
  console.log(`  seats:  ${counts.seats}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
