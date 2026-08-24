import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Booking, Prisma, Seat } from '@prisma/client';
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
import { isRedisUnavailableError } from '../redis/redis-errors.util';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LockService, SeatLock } from './lock.service';

const IDEM_TTL_SECONDS = 24 * 60 * 60; // spec §5: idem:<userId>:<key> → orderId, 24h
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const PAYMENT_METHODS = ['credit_card', 'debit_card', 'upi', 'wallet'] as const;
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 1_000 }, // kept around for admin.queueStats avgMs
  removeOnFail: { count: 1_000 },
} as const;

type Tx = Prisma.TransactionClient;
type AssignedInput = Extract<CreateBookingInput, { kind: 'assigned' }>;

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
  orderId: string | null;
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
  orderId: b.orderId,
  quantity: b.quantity,
  status: b.status,
  failReason: b.failReason,
  createdAt: b.createdAt.toISOString(),
  confirmedAt: b.confirmedAt?.toISOString() ?? null,
});

/** Internal: payment declined inside the transaction → rollback + FAILED row(s). */
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

const badRequest = (message: string): TRPCError =>
  new TRPCError({ code: 'BAD_REQUEST', message });

const TERMINAL_BUSINESS_ERRORS = new Set([
  'SEAT_TAKEN',
  'SOLD_OUT',
  'EVENT_NOT_ON_SALE',
  'SEAT_LIMIT_EXCEEDED',
]);

/**
 * The atomic booking core (ARCHITECTURE.md §3). One Prisma transaction per
 * order: re-read state → guarded UPDATE per seat (status CAS / conditional
 * decrement) → booking row(s) → mock charge → transaction row(s). Anything
 * throws, everything rolls back — no state where a seat is booked without a
 * booking, or a booking exists without a transaction record, and no state
 * where *some* seats in a multi-seat order are booked and others aren't.
 *
 * Path A (direct) and Path B (queued, on lock contention) run the exact same
 * transaction methods; Path B upserts over the PENDING rows it created first.
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
  ): Promise<BookingDto[]> {
    // 10 booking attempts / 15 min / user (spec §3) — a fraud/abuse control.
    // One order (however many seats) counts once.
    const allowed = await this.rateLimit.consume(
      `rl:booking:${user.id}`,
      Number(this.config.get('RATE_LIMIT_BOOKING_MAX') ?? 10),
      15 * 60 * 1000,
    );
    if (!allowed) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'RATE_LIMITED' });
    }

    const idemKey = `idem:${user.id}:${meta.idempotencyKey}`;
    const orderId = randomUUID();
    const bookingIds =
      input.kind === 'assigned' ? input.seatIds.map(() => randomUUID()) : [orderId];

    // Atomic claim: SET NX GET returns the previously stored orderId if the
    // key already exists, so N parallel identical requests elect one winner.
    let existingOrderId: string | null;
    try {
      existingOrderId = (await this.redis.call(
        'SET',
        idemKey,
        orderId,
        'EX',
        IDEM_TTL_SECONDS,
        'NX',
        'GET',
      )) as string | null;
    } catch (err) {
      if (isRedisUnavailableError(err)) {
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Try again shortly' });
      }
      throw err;
    }
    if (existingOrderId !== null) {
      const expected = input.kind === 'assigned' ? input.seatIds.length : 1;
      return this.awaitExistingOrder(existingOrderId, expected);
    }

    try {
      if (input.kind === 'assigned') {
        return await this.createAssigned(user, input, bookingIds, orderId, meta);
      }
      const { booking, remaining } = await this.runGeneralTransaction(
        user,
        input.quantity,
        input.eventId,
        orderId, // GA reuses the order id as its single booking id
        meta,
        input.timeToCompleteMs,
      );
      this.gateway.emitCapacityUpdated(input.eventId, remaining);
      await this.enqueueConfirmation(booking.id, user.email);
      return [booking];
    } catch (err) {
      if (err instanceof PaymentDeclinedError) {
        // The transaction rolled back (seats/capacity untouched, no
        // transaction rows); persist the outcome so the idempotency key
        // resolves for every row this order would have created.
        const rows = await Promise.all(
          bookingIds.map((bookingId, i) =>
            this.prisma.booking.upsert({
              where: { id: bookingId },
              update: { status: 'FAILED', failReason: err.failureCode },
              create: {
                id: bookingId,
                userId: user.id,
                eventId: input.eventId,
                seatId: input.kind === 'assigned' ? input.seatIds[i]! : null,
                orderId: input.kind === 'assigned' ? orderId : null,
                quantity: input.kind === 'general' ? input.quantity : 1,
                status: 'FAILED',
                failReason: err.failureCode,
              },
            }),
          ),
        );
        return rows.map(toBookingDto);
      }
      // No booking row exists for this key — release it so a retry can proceed.
      await this.redis.del(idemKey);
      throw err;
    }
  }

  private async createAssigned(
    user: AuthenticatedUser,
    input: AssignedInput,
    bookingIds: string[],
    orderId: string,
    meta: BookingRequestMeta,
  ): Promise<BookingDto[]> {
    const seatIds = input.seatIds;

    // Advisory pre-lock read (ARCHITECTURE.md §3.1): fail fast on an
    // obviously-dead order (unknown seat, wrong event, already booked, or
    // over the event's per-order cap) before touching any lock. Correctness
    // still rests on the in-transaction re-read + guarded UPDATE below.
    const preRead = await this.prisma.seat.findMany({
      where: { id: { in: seatIds } },
      select: { id: true, status: true, eventId: true },
    });
    if (
      preRead.length !== seatIds.length ||
      preRead.some((s) => s.eventId !== input.eventId)
    ) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Seat not found' });
    }
    if (preRead.some((s) => s.status !== 'AVAILABLE')) throw conflict('SEAT_TAKEN');
    await this.assertSeatLimit(input.eventId, seatIds.length);

    // Layer 1: fail-fast per-seat locks, acquired in a fixed (sorted) order
    // across all seats in the order to avoid deadlocking against another
    // concurrent multi-seat order over the same seats. Any single seat
    // already locked → Path B: enqueue the whole order and answer "pending".
    const locks = await this.locks.acquireSeatLocks(seatIds);
    if (!locks) return this.enqueueOrder(user, input, bookingIds, orderId, meta);

    let bookings: BookingDto[];
    try {
      bookings = await this.runAssignedTransaction(
        user,
        seatIds,
        input.eventId,
        bookingIds,
        orderId,
        meta,
        input.timeToCompleteMs,
      );
    } finally {
      await this.locks.releaseAll(locks);
    }
    for (const seatId of seatIds) this.gateway.emitSeatUpdated(input.eventId, seatId, 'BOOKED');
    await Promise.all(bookings.map((b) => this.enqueueConfirmation(b.id, user.email)));
    return bookings;
  }

  /** Re-checked INSIDE the transaction too — an event's cap can't be raced
   * because it's read from the same row the CAS update touches. */
  private async assertSeatLimit(eventId: string, requested: number, tx: Tx | PrismaService = this.prisma): Promise<void> {
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: { maxSeatsPerOrder: true },
    });
    if (event?.maxSeatsPerOrder != null && requested > event.maxSeatsPerOrder) {
      throw badRequest('SEAT_LIMIT_EXCEEDED');
    }
  }

  /** Path B (ARCHITECTURE.md §2): pending rows first, then the job — the
   * client always has something to poll. One row per seat, sharing orderId. */
  private async enqueueOrder(
    user: AuthenticatedUser,
    input: AssignedInput,
    bookingIds: string[],
    orderId: string,
    meta: BookingRequestMeta,
  ): Promise<BookingDto[]> {
    const bookings = await this.prisma.$transaction(
      input.seatIds.map((seatId, i) =>
        this.prisma.booking.create({
          data: {
            id: bookingIds[i]!,
            userId: user.id,
            eventId: input.eventId,
            seatId,
            orderId,
            quantity: 1,
            status: 'PENDING',
          },
        }),
      ),
    );
    const jobData: ProcessBookingJobData = { bookingIds, orderId, user, input, meta };
    // jobId dedupes on the order, not any single seat — a retry of the same
    // order never double-enqueues.
    await this.queue.add(PROCESS_BOOKING_JOB, jobData, { ...JOB_OPTIONS, jobId: orderId });
    return bookings.map(toBookingDto);
  }

  /** Executed by the BullMQ worker — same transaction as the direct path. */
  async processQueuedBooking(data: ProcessBookingJobData): Promise<void> {
    const current = await this.prisma.booking.findMany({
      where: { id: { in: data.bookingIds } },
    });
    if (current.length === 0 || current.every((b) => b.status !== 'PENDING')) return; // already resolved

    if (data.input.kind !== 'assigned') {
      // only the assigned path ever enqueues
      await this.failOrder(data.bookingIds, data.user.id, 'INVALID_JOB');
      return;
    }

    const seatIds = data.input.seatIds;
    const locks = await this.locks.acquireSeatLocks(seatIds);
    if (!locks) throw new SeatLockBusyError(); // retryable → BullMQ backoff

    let bookings: BookingDto[];
    try {
      bookings = await this.runAssignedTransaction(
        data.user,
        seatIds,
        data.input.eventId,
        data.bookingIds,
        data.orderId,
        data.meta,
        data.input.timeToCompleteMs,
      );
    } catch (err) {
      if (err instanceof PaymentDeclinedError) {
        await this.failOrder(data.bookingIds, data.user.id, err.failureCode);
        return;
      }
      if (err instanceof TRPCError && TERMINAL_BUSINESS_ERRORS.has(err.message)) {
        await this.failOrder(data.bookingIds, data.user.id, err.message);
        return;
      }
      throw err; // transient (DB hiccup, …) → BullMQ retries
    } finally {
      await this.locks.releaseAll(locks);
    }

    for (const seatId of seatIds) this.gateway.emitSeatUpdated(data.input.eventId, seatId, 'BOOKED');
    for (const booking of bookings) {
      this.gateway.emitBookingStatus(data.user.id, { bookingId: booking.id, status: 'CONFIRMED' });
      await this.enqueueConfirmation(booking.id, data.user.email);
    }
  }

  /** Terminal failure: PENDING → FAILED (capacity/seats untouched — the
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

  private async failOrder(bookingIds: string[], userId: string, reason: string): Promise<void> {
    await Promise.all(bookingIds.map((id) => this.failBooking(id, userId, reason)));
  }

  private async enqueueConfirmation(bookingId: string, email: string): Promise<void> {
    await this.queue.add(SEND_CONFIRMATION_JOB, { bookingId, email }, JOB_OPTIONS);
  }

  /** All-or-nothing across every seat in the order: every seat's guarded
   * UPDATE must succeed inside this one transaction, or the whole thing (and
   * the earlier ones in this call) rolls back — never a partially-booked
   * order. */
  private async runAssignedTransaction(
    user: AuthenticatedUser,
    seatIds: string[],
    eventId: string,
    bookingIds: string[],
    orderId: string,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<BookingDto[]> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertOnSale(tx, eventId);
      await this.assertSeatLimit(eventId, seatIds.length, tx);

      const seats = await tx.seat.findMany({ where: { id: { in: seatIds }, eventId } });
      if (seats.length !== seatIds.length) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Seat not found' });
      }
      if (seats.some((s) => s.status !== 'AVAILABLE')) throw conflict('SEAT_TAKEN');

      // Layer 2: status-based conditional update per seat — a compare-and-swap
      // on the one mutable field that matters, holds even if a seat lock
      // expired or was stolen (DECISIONS.md). One failed CAS throws and rolls
      // every seat in the order back, including ones whose CAS just succeeded.
      for (const seatId of seatIds) {
        const updated = await tx.$executeRaw`
          UPDATE "Seat" SET "status" = 'BOOKED'
          WHERE "id" = ${seatId} AND "status" = 'AVAILABLE'`;
        if (updated === 0) throw conflict('SEAT_TAKEN');
      }

      const confirmed = { status: 'CONFIRMED' as const, confirmedAt: new Date() };
      const seatById = new Map(seats.map((s) => [s.id, s]));
      const bookings: Booking[] = [];
      for (let i = 0; i < seatIds.length; i++) {
        const booking = await tx.booking.upsert({
          where: { id: bookingIds[i]! },
          update: confirmed,
          create: {
            id: bookingIds[i]!,
            userId: user.id,
            eventId,
            seatId: seatIds[i]!,
            orderId,
            quantity: 1,
            ...confirmed,
          },
        });
        bookings.push(booking);
      }
      await this.chargeAndRecordOrder(tx, user, bookings, seatById, meta, timeToCompleteMs);
      return bookings.map(toBookingDto);
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

    await this.recordTransaction(tx, user, booking, amountCents, result, meta, timeToCompleteMs);
  }

  /**
   * Multi-seat order: one payment-provider charge for the order total (a
   * real card is only ever swiped once per checkout), then one Transaction
   * row per seat/booking — each carries its own seat price and the fraud
   * fields already scoped per-booking, so per-seat fraud labeling
   * (Transaction.isFraud) is untouched. All rows share the charge's
   * providerRef, which is how they're traced back to the one charge.
   */
  private async chargeAndRecordOrder(
    tx: Tx,
    user: AuthenticatedUser,
    bookings: Booking[],
    seatById: Map<string, Seat>,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<void> {
    const amountCents = bookings.reduce(
      (sum, b) => sum + seatById.get(b.seatId!)!.priceCents,
      0,
    );
    const result: ChargeResult = await this.payments.charge({
      userId: user.id,
      bookingId: bookings[0]!.id, // representative id for the mock provider's dedupe
      amountCents,
      currency: 'INR',
      idempotencyKey: meta.idempotencyKey,
    });
    if (!result.ok) throw new PaymentDeclinedError(result.failureCode ?? 'provider_error');

    for (const booking of bookings) {
      const seatAmount = seatById.get(booking.seatId!)!.priceCents;
      await this.recordTransaction(tx, user, booking, seatAmount, result, meta, timeToCompleteMs);
    }
  }

  private async recordTransaction(
    tx: Tx,
    user: AuthenticatedUser,
    booking: Booking,
    amountCents: number,
    result: ChargeResult,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<void> {
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

  /** A concurrent duplicate owns this idempotency key — wait for its rows. */
  private async awaitExistingOrder(
    orderId: string,
    expectedCount: number,
    timeoutMs = 10_000,
  ): Promise<BookingDto[]> {
    const deadline = Date.now() + timeoutMs;
    do {
      const bookings = await this.prisma.booking.findMany({
        where: { OR: [{ orderId }, { id: orderId }] }, // GA reuses orderId as its booking id
      });
      if (bookings.length >= expectedCount) return bookings.map(toBookingDto);
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
