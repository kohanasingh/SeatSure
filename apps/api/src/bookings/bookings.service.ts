import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Booking, Prisma } from '@prisma/client';
import { CreateBookingInput } from '@seatsure/shared';
import { TRPCError } from '@trpc/server';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { AuthenticatedUser } from '../auth/types';
import {
  ChargeResult,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/payment.provider';
import { PrismaService } from '../prisma/prisma.service';
import {
  BOOKINGS_QUEUE,
  BookingsJobData,
  PROCESS_BOOKING_JOB,
  ProcessBookingJobData,
  SEND_CONFIRMATION_JOB,
} from '../queue/bookings-queue.module';
import { RateLimitService } from '../redis/rate-limit.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LockService } from './lock.service';

const IDEM_TTL_SECONDS = 24 * 60 * 60; // spec §5: idem:<userId>:<key> → bookingId, 24h
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const PAYMENT_METHODS = ['credit_card', 'debit_card', 'upi', 'wallet'] as const;
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 1_000 }, // kept around for admin.queueStats avgMs
  removeOnFail: { count: 1_000 },
} as const;

type Tx = Prisma.TransactionClient;

export interface BookingRequestMeta {
  idempotencyKey: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  acceptLanguage?: string;
  screenHint?: string;
}

export interface BookingDto {
  id: string;
  userId: string;
  eventId: string;
  seatId: string | null;
  quantity: number;
  status: Booking['status'];
  failReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export const toBookingDto = (b: Booking): BookingDto => ({
  id: b.id,
  userId: b.userId,
  eventId: b.eventId,
  seatId: b.seatId,
  quantity: b.quantity,
  status: b.status,
  failReason: b.failReason,
  createdAt: b.createdAt.toISOString(),
  confirmedAt: b.confirmedAt?.toISOString() ?? null,
});

/** Internal: payment declined inside the transaction → rollback + FAILED row. */
class PaymentDeclinedError extends Error {
  constructor(public readonly failureCode: string) {
    super(failureCode);
  }
}

/** Internal: seat lock held by someone else while processing a queued job — retryable. */
export class SeatLockBusyError extends Error {
  constructor() {
    super('Seat lock busy');
  }
}

const conflict = (message: 'SEAT_TAKEN' | 'SOLD_OUT'): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message });

const TERMINAL_BUSINESS_ERRORS = new Set(['SEAT_TAKEN', 'SOLD_OUT', 'EVENT_NOT_ON_SALE']);

/**
 * The atomic booking core (ARCHITECTURE.md §3). One Prisma transaction:
 * re-read state → guarded UPDATE (status CAS / conditional decrement) →
 * booking row → mock charge → transactions row. Anything throws, everything
 * rolls back — no state where a seat is booked without a booking, or a
 * booking exists without a transaction record.
 *
 * Path A (direct) and Path B (queued, on lock contention) run the exact same
 * transaction methods; Path B upserts over the PENDING row it created first.
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    private readonly gateway: RealtimeGateway,
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(BOOKINGS_QUEUE) private readonly queue: Queue<BookingsJobData>,
  ) {}

  async create(
    user: AuthenticatedUser,
    input: CreateBookingInput,
    meta: BookingRequestMeta,
  ): Promise<BookingDto> {
    // 10 booking attempts / 15 min / user (spec §3) — a fraud/abuse control
    const allowed = await this.rateLimit.consume(
      `rl:booking:${user.id}`,
      Number(this.config.get('RATE_LIMIT_BOOKING_MAX') ?? 10),
      15 * 60 * 1000,
    );
    if (!allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'RATE_LIMITED' });
    }

    const idemKey = `idem:${user.id}:${meta.idempotencyKey}`;
    const bookingId = randomUUID();

    // Atomic claim: SET NX GET returns the previously stored bookingId if the
    // key already exists, so N parallel identical requests elect one winner.
    const existingId = (await this.redis.call(
      'SET',
      idemKey,
      bookingId,
      'EX',
      IDEM_TTL_SECONDS,
      'NX',
      'GET',
    )) as string | null;
    if (existingId !== null) return this.awaitExistingBooking(existingId);

    try {
      if (input.kind === 'assigned') {
        return await this.createAssigned(user, input, bookingId, meta);
      }
      const { booking, remaining } = await this.runGeneralTransaction(
        user,
        input.quantity,
        input.eventId,
        bookingId,
        meta,
        input.timeToCompleteMs,
      );
      this.gateway.emitCapacityUpdated(input.eventId, remaining);
      await this.enqueueConfirmation(booking.id, user.email);
      return booking;
    } catch (err) {
      if (err instanceof PaymentDeclinedError) {
        // The transaction rolled back (seat/capacity untouched, no transaction
        // row); persist the outcome so the idempotency key resolves.
        const failed = await this.prisma.booking.upsert({
          where: { id: bookingId },
          update: { status: 'FAILED', failReason: err.failureCode },
          create: {
            id: bookingId,
            userId: user.id,
            eventId: input.eventId,
            seatId: input.kind === 'assigned' ? input.seatId : null,
            quantity: input.kind === 'general' ? input.quantity : 1,
            status: 'FAILED',
            failReason: err.failureCode,
          },
        });
        return toBookingDto(failed);
      }
      // No booking row exists for this key — release it so a retry can proceed.
      await this.redis.del(idemKey);
      throw err;
    }
  }

  private async createAssigned(
    user: AuthenticatedUser,
    input: Extract<CreateBookingInput, { kind: 'assigned' }>,
    bookingId: string,
    meta: BookingRequestMeta,
  ): Promise<BookingDto> {
    // Advisory pre-lock read (ARCHITECTURE.md §3.1): a seat that is already
    // BOOKED answers immediately — no lock, no transaction. Under a sold-out
    // spike this short-circuits the vast majority of requests; correctness
    // still rests on the in-transaction re-read + guarded UPDATE.
    const preRead = await this.prisma.seat.findUnique({
      where: { id: input.seatId },
      select: { status: true, eventId: true },
    });
    if (!preRead || preRead.eventId !== input.eventId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Seat not found' });
    }
    if (preRead.status !== 'AVAILABLE') throw conflict('SEAT_TAKEN');

    // Layer 1: fail-fast per-seat lock. A held lock means someone is booking
    // this seat right now → Path B: enqueue and answer "pending" immediately.
    const lock = await this.locks.acquireSeatLock(input.seatId);
    if (!lock) return this.enqueueBooking(user, input, bookingId, meta);

    let booking: BookingDto;
    try {
      booking = await this.runAssignedTransaction(
        user,
        input.seatId,
        input.eventId,
        bookingId,
        meta,
        input.timeToCompleteMs,
      );
    } finally {
      await this.locks.release(lock);
    }
    this.gateway.emitSeatUpdated(input.eventId, input.seatId, 'BOOKED');
    await this.enqueueConfirmation(booking.id, user.email);
    return booking;
  }

  /** Path B (ARCHITECTURE.md §2): pending row first, then the job — the
   * client always has something to poll. */
  private async enqueueBooking(
    user: AuthenticatedUser,
    input: Extract<CreateBookingInput, { kind: 'assigned' }>,
    bookingId: string,
    meta: BookingRequestMeta,
  ): Promise<BookingDto> {
    const booking = await this.prisma.booking.create({
      data: {
        id: bookingId,
        userId: user.id,
        eventId: input.eventId,
        seatId: input.seatId,
        quantity: 1,
        status: 'PENDING',
      },
    });
    const jobData: ProcessBookingJobData = { bookingId, user, input, meta };
    await this.queue.add(PROCESS_BOOKING_JOB, jobData, { ...JOB_OPTIONS, jobId: bookingId });
    return toBookingDto(booking);
  }

  /** Executed by the BullMQ worker — same transaction as the direct path. */
  async processQueuedBooking(data: ProcessBookingJobData): Promise<void> {
    const current = await this.prisma.booking.findUnique({ where: { id: data.bookingId } });
    if (!current || current.status !== 'PENDING') return; // already resolved

    if (data.input.kind !== 'assigned') {
      // only the assigned path ever enqueues
      await this.failBooking(data.bookingId, data.user.id, 'INVALID_JOB');
      return;
    }

    const lock = await this.locks.acquireSeatLock(data.input.seatId);
    if (!lock) throw new SeatLockBusyError(); // retryable → BullMQ backoff

    let booking: BookingDto;
    try {
      booking = await this.runAssignedTransaction(
        data.user,
        data.input.seatId,
        data.input.eventId,
        data.bookingId,
        data.meta,
        data.input.timeToCompleteMs,
      );
    } catch (err) {
      if (err instanceof PaymentDeclinedError) {
        await this.failBooking(data.bookingId, data.user.id, err.failureCode);
        return;
      }
      if (err instanceof TRPCError && TERMINAL_BUSINESS_ERRORS.has(err.message)) {
        await this.failBooking(data.bookingId, data.user.id, err.message);
        return;
      }
      throw err; // transient (DB hiccup, …) → BullMQ retries
    } finally {
      await this.locks.release(lock);
    }

    this.gateway.emitSeatUpdated(data.input.eventId, data.input.seatId, 'BOOKED');
    this.gateway.emitBookingStatus(data.user.id, { bookingId: booking.id, status: 'CONFIRMED' });
    await this.enqueueConfirmation(booking.id, data.user.email);
  }

  /** Terminal failure: PENDING → FAILED (capacity/seat untouched — the
   * transaction never committed), pushed to the user's room. */
  async failBooking(bookingId: string, userId: string, reason: string): Promise<void> {
    const { count } = await this.prisma.booking.updateMany({
      where: { id: bookingId, status: 'PENDING' },
      data: { status: 'FAILED', failReason: reason },
    });
    if (count === 1) {
      this.gateway.emitBookingStatus(userId, { bookingId, status: 'FAILED', failReason: reason });
    }
  }

  private async enqueueConfirmation(bookingId: string, email: string): Promise<void> {
    await this.queue.add(SEND_CONFIRMATION_JOB, { bookingId, email }, JOB_OPTIONS);
  }

  private async runAssignedTransaction(
    user: AuthenticatedUser,
    seatId: string,
    eventId: string,
    bookingId: string,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<BookingDto> {
    return this.prisma.$transaction(async (tx) => {
      const seat = await tx.seat.findUnique({ where: { id: seatId } });
      if (!seat || seat.eventId !== eventId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Seat not found' });
      }
      await this.assertOnSale(tx, eventId);
      if (seat.status !== 'AVAILABLE') throw conflict('SEAT_TAKEN');

      // Layer 2: status-based conditional update — a compare-and-swap on the
      // one mutable field that matters, holds even if the seat lock expired
      // or was stolen (DECISIONS.md).
      const updated = await tx.$executeRaw`
        UPDATE "Seat" SET "status" = 'BOOKED'
        WHERE "id" = ${seatId} AND "status" = 'AVAILABLE'`;
      if (updated === 0) throw conflict('SEAT_TAKEN');

      const confirmed = { status: 'CONFIRMED' as const, confirmedAt: new Date() };
      const booking = await tx.booking.upsert({
        where: { id: bookingId },
        update: confirmed, // queued path: over the PENDING row
        create: {
          id: bookingId,
          userId: user.id,
          eventId,
          seatId,
          quantity: 1,
          ...confirmed,
        },
      });
      await this.chargeAndRecord(tx, user, booking, seat.priceCents, meta, timeToCompleteMs);
      return toBookingDto(booking);
    }, TX_OPTIONS);
  }

  private async runGeneralTransaction(
    user: AuthenticatedUser,
    quantity: number,
    eventId: string,
    bookingId: string,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<{ booking: BookingDto; remaining: number }> {
    // No lock: the conditional decrement + Postgres row locking serialize
    // concurrent decrements safely (ARCHITECTURE.md §2.4).
    return this.prisma.$transaction(async (tx) => {
      const event = await this.assertOnSale(tx, eventId);
      if (event.seatingType !== 'GENERAL' || event.gaPriceCents === null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a general-admission event' });
      }

      const rows = await tx.$queryRaw<{ remainingCapacity: number }[]>`
        UPDATE "Event" SET "remainingCapacity" = "remainingCapacity" - ${quantity}
        WHERE "id" = ${eventId} AND "remainingCapacity" >= ${quantity}
        RETURNING "remainingCapacity"`;
      const remaining = rows[0]?.remainingCapacity;
      if (remaining === undefined) throw conflict('SOLD_OUT');

      const confirmed = { status: 'CONFIRMED' as const, confirmedAt: new Date() };
      const booking = await tx.booking.upsert({
        where: { id: bookingId },
        update: confirmed,
        create: { id: bookingId, userId: user.id, eventId, quantity, ...confirmed },
      });
      await this.chargeAndRecord(
        tx,
        user,
        booking,
        event.gaPriceCents * quantity,
        meta,
        timeToCompleteMs,
      );
      return { booking: toBookingDto(booking), remaining };
    }, TX_OPTIONS);
  }

  /** Re-checked INSIDE the transaction too (ARCHITECTURE.md §8.3). */
  private async assertOnSale(tx: Tx, eventId: string) {
    const event = await tx.event.findUnique({ where: { id: eventId } });
    if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
    if (event.status !== 'ON_SALE') {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'EVENT_NOT_ON_SALE' });
    }
    return event;
  }

  /**
   * Mock charge (synchronous, in-process) lives inside the transaction window
   * — v1 simplification; Stripe later moves this into a saga outside the
   * transaction, touching only this service. Writes the transactions row with
   * every fraud-relevant field (API_AND_DATA_SPEC.md §2).
   */
  private async chargeAndRecord(
    tx: Tx,
    user: AuthenticatedUser,
    booking: Booking,
    amountCents: number,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<void> {
    const result: ChargeResult = await this.payments.charge({
      userId: user.id,
      bookingId: booking.id,
      amountCents,
      currency: 'INR',
      idempotencyKey: meta.idempotencyKey,
    });
    if (!result.ok) throw new PaymentDeclinedError(result.failureCode ?? 'provider_error');

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [attemptCount, priorBookings, dbUser] = await Promise.all([
      // includes the row inserted above → count is "attempts incl. this one"
      tx.booking.count({ where: { userId: user.id, eventId: booking.eventId, createdAt: { gte: dayAgo } } }),
      tx.booking.count({ where: { userId: user.id, id: { not: booking.id } } }),
      tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { createdAt: true } }),
    ]);

    const fingerprintSource = [meta.userAgent, meta.acceptLanguage, meta.screenHint]
      .filter(Boolean)
      .join('|');

    await tx.transaction.create({
      data: {
        userId: user.id,
        bookingId: booking.id,
        amountCents,
        currency: 'INR',
        // mock provider has no real instrument — pick deterministically
        paymentMethod:
          PAYMENT_METHODS[
            createHash('sha256').update(booking.id).digest()[0]! % PAYMENT_METHODS.length
          ]!,
        paymentProviderRef: result.providerRef,
        ipAddress: meta.ipAddress ?? null,
        deviceFingerprint: fingerprintSource
          ? createHash('sha256').update(fingerprintSource).digest('hex')
          : null,
        userAgent: meta.userAgent ?? null,
        bookingAttemptCount: attemptCount,
        timeToCompleteMs: timeToCompleteMs ?? null,
        isFirstBooking: priorBookings === 0,
        accountAgeDays: Math.floor(
          (Date.now() - dbUser.createdAt.getTime()) / (24 * 60 * 60 * 1000),
        ),
      },
    });
  }

  /** A concurrent duplicate owns this idempotency key — wait for its row. */
  private async awaitExistingBooking(bookingId: string, timeoutMs = 10_000): Promise<BookingDto> {
    const deadline = Date.now() + timeoutMs;
    do {
      const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
      if (booking) return toBookingDto(booking);
      await sleep(100);
    } while (Date.now() < deadline);
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Identical request still in flight — retry shortly',
    });
  }

  async getStatus(
    user: AuthenticatedUser,
    bookingId: string,
  ): Promise<{ status: Booking['status']; failReason: string | null }> {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.userId !== user.id) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });
    }
    return { status: booking.status, failReason: booking.failReason };
  }

  async myBookings(
    user: AuthenticatedUser,
    query: { cursor?: string; limit: number },
  ): Promise<{ items: (BookingDto & { eventTitle: string; seatNumber: string | null })[]; nextCursor: string | null }> {
    const rows = await this.prisma.booking.findMany({
      where: { userId: user.id },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { event: { select: { title: true } }, seat: { select: { seatNumber: true } } },
    });
    const items = rows.slice(0, query.limit).map((b) => ({
      ...toBookingDto(b),
      eventTitle: b.event.title,
      seatNumber: b.seat?.seatNumber ?? null,
    }));
    return {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
  }
}
