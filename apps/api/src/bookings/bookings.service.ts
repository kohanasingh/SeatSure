import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import { Booking, Prisma } from '@prisma/client';
import { CreateBookingInput } from '@seatsure/shared';
import { TRPCError } from '@trpc/server';
import Redis from 'ioredis';
import { AuthenticatedUser } from '../auth/types';
import {
  ChargeResult,
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/payment.provider';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { LockService } from './lock.service';

const IDEM_TTL_SECONDS = 24 * 60 * 60; // spec §5: idem:<userId>:<key> → bookingId, 24h
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const PAYMENT_METHODS = ['credit_card', 'debit_card', 'upi', 'wallet'] as const;

type Tx = Prisma.TransactionClient;

export interface BookingRequestMeta {
  idempotencyKey: string;
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

const conflict = (message: 'SEAT_TAKEN' | 'SOLD_OUT'): TRPCError =>
  new TRPCError({ code: 'CONFLICT', message });

/**
 * The atomic booking core (ARCHITECTURE.md §3). One Prisma transaction:
 * re-read state → guarded UPDATE (version check / conditional decrement) →
 * booking row → mock charge → transactions row. Anything throws, everything
 * rolls back — no state where a seat is booked without a booking, or a
 * booking exists without a transaction record.
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LockService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  async create(
    user: AuthenticatedUser,
    input: CreateBookingInput,
    meta: BookingRequestMeta,
  ): Promise<BookingDto> {
    const idemKey = `idem:${user.id}:${meta.idempotencyKey}`;
    const bookingId = randomUUID();

    // Atomic claim: SET NX GET returns the previously stored bookingId if the
    // key already exists, so 10 parallel identical requests elect one winner.
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
        return await this.createAssigned(user, input.seatId, input.eventId, bookingId, meta, input.timeToCompleteMs);
      }
      return await this.createGeneral(user, input.quantity, input.eventId, bookingId, meta, input.timeToCompleteMs);
    } catch (err) {
      if (err instanceof PaymentDeclinedError) {
        // The transaction rolled back (seat/capacity untouched, no transaction
        // row); persist the outcome so the idempotency key resolves.
        const failed = await this.prisma.booking.create({
          data: {
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
    seatId: string,
    eventId: string,
    bookingId: string,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<BookingDto> {
    // Layer 1: fail-fast per-seat lock. A held lock means someone is booking
    // this seat right now — answer immediately (Phase 4 enqueues instead).
    const lock = await this.locks.acquireSeatLock(seatId);
    if (!lock) throw conflict('SEAT_TAKEN');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const seat = await tx.seat.findUnique({ where: { id: seatId } });
        if (!seat || seat.eventId !== eventId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Seat not found' });
        }
        await this.assertOnSale(tx, eventId);
        if (seat.status !== 'AVAILABLE') throw conflict('SEAT_TAKEN');

        // Layers 2+3: optimistic version check and status condition in one
        // guarded UPDATE — holds even if the Redlock expired or was stolen.
        const updated = await tx.$executeRaw`
          UPDATE "Seat" SET "status" = 'BOOKED', "version" = "version" + 1
          WHERE "id" = ${seatId} AND "status" = 'AVAILABLE' AND "version" = ${seat.version}`;
        if (updated === 0) throw conflict('SEAT_TAKEN');

        const booking = await tx.booking.create({
          data: {
            id: bookingId,
            userId: user.id,
            eventId,
            seatId,
            quantity: 1,
            status: 'CONFIRMED',
            confirmedAt: new Date(),
          },
        });
        await this.chargeAndRecord(tx, user, booking, seat.priceCents, meta, timeToCompleteMs);
        return toBookingDto(booking);
      }, TX_OPTIONS);
    } finally {
      await this.locks.release(lock);
    }
  }

  private async createGeneral(
    user: AuthenticatedUser,
    quantity: number,
    eventId: string,
    bookingId: string,
    meta: BookingRequestMeta,
    timeToCompleteMs?: number,
  ): Promise<BookingDto> {
    // No lock: the conditional decrement + Postgres row locking serialize
    // concurrent decrements safely (ARCHITECTURE.md §2.4).
    return this.prisma.$transaction(async (tx) => {
      const event = await this.assertOnSale(tx, eventId);
      if (event.seatingType !== 'GENERAL' || event.gaPriceCents === null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a general-admission event' });
      }

      const updated = await tx.$executeRaw`
        UPDATE "Event" SET "remainingCapacity" = "remainingCapacity" - ${quantity}
        WHERE "id" = ${eventId} AND "remainingCapacity" >= ${quantity}`;
      if (updated === 0) throw conflict('SOLD_OUT');

      const booking = await tx.booking.create({
        data: {
          id: bookingId,
          userId: user.id,
          eventId,
          quantity,
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      });
      await this.chargeAndRecord(
        tx,
        user,
        booking,
        event.gaPriceCents * quantity,
        meta,
        timeToCompleteMs,
      );
      return toBookingDto(booking);
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
