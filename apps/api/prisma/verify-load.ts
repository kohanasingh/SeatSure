import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// The zero-oversell proof (BUILD_PHASES.md Phase 5): after the k6 run,
// confirmed bookings == distinct booked seats == seats with status BOOKED.

const prisma = new PrismaClient();
const EVENT_TITLE = 'k6 Booking Spike';

async function main(): Promise<void> {
  const event = await prisma.event.findFirstOrThrow({ where: { title: EVENT_TITLE } });

  const confirmedBookings = await prisma.booking.count({
    where: { eventId: event.id, status: 'CONFIRMED' },
  });
  const distinctBookedSeats = (
    await prisma.booking.findMany({
      where: { eventId: event.id, status: 'CONFIRMED' },
      distinct: ['seatId'],
      select: { seatId: true },
    })
  ).length;
  const seatsBooked = await prisma.seat.count({
    where: { eventId: event.id, status: 'BOOKED' },
  });
  const transactions = await prisma.transaction.count({
    where: { booking: { eventId: event.id, status: 'CONFIRMED' } },
  });
  const failed = await prisma.booking.count({
    where: { eventId: event.id, status: 'FAILED' },
  });
  const pending = await prisma.booking.count({
    where: { eventId: event.id, status: 'PENDING' },
  });

  console.log('--- k6 zero-oversell verification ---');
  console.log(`confirmed bookings:        ${confirmedBookings}`);
  console.log(`distinct booked seats:     ${distinctBookedSeats}`);
  console.log(`seats with status BOOKED:  ${seatsBooked}`);
  console.log(`transaction rows:          ${transactions}`);
  console.log(`failed bookings:           ${failed}`);
  console.log(`pending bookings:          ${pending}`);

  const ok =
    confirmedBookings === distinctBookedSeats &&
    confirmedBookings === seatsBooked &&
    confirmedBookings === transactions &&
    pending === 0;
  console.log(ok ? 'RESULT: ZERO OVERSELL ✓' : 'RESULT: MISMATCH — INVESTIGATE ✗');
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
