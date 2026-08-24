import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TRPCError } from '@trpc/server';
import Redis from 'ioredis';
import { isRedisUnavailableError } from '../redis/redis-errors.util';
import { REDIS_CLIENT } from '../redis/redis.constants';

const redisUnavailable = (): never => {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Try again shortly' });
};

export const SEAT_LOCK_TTL_MS = 5_000;
export const seatLockKey = (seatId: string): string => `lock:seat:${seatId}`;

export interface SeatLock {
  key: string;
  token: string;
}

// Redlock's safe-release: only the token holder may delete the key, so a lock
// that expired and was re-acquired by someone else is never released by us.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Defense layer 1 (ARCHITECTURE.md §4): a per-seat lock serializes the hot
 * path so contenders fail fast instead of stampeding Postgres. This is the
 * Redlock algorithm's single-instance primitive (SET NX PX + token-checked
 * release) — with one Redis node the multi-node quorum adds nothing (see
 * DECISIONS.md). Correctness never depends on it; layers 2–5 hold even if
 * the lock vanishes mid-flight.
 */
@Injectable()
export class LockService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** No retries — a busy seat is answered immediately. Null = not acquired. */
  async acquireSeatLock(seatId: string): Promise<SeatLock | null> {
    const lock: SeatLock = { key: seatLockKey(seatId), token: randomUUID() };
    try {
      const ok = await this.redis.set(lock.key, lock.token, 'PX', SEAT_LOCK_TTL_MS, 'NX');
      return ok === 'OK' ? lock : null;
    } catch (err) {
      if (isRedisUnavailableError(err)) redisUnavailable();
      throw err;
    }
  }

  async release(lock: SeatLock): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
    } catch (err) {
      if (isRedisUnavailableError(err)) redisUnavailable();
      throw err;
    }
  }

  /**
   * Multi-seat orders (ARCHITECTURE.md §4): acquire every seat's lock before
   * touching Postgres. Seat IDs are sorted first so two concurrent orders
   * that both want {seatA, seatB} always try to lock them in the same
   * order — the standard fixed-ordering deadlock-avoidance rule; without it
   * two overlapping multi-seat orders could each hold one lock and wait
   * forever on the other.
   *
   * All-or-nothing: any single failed acquisition releases everything already
   * held and returns null (→ caller falls back to the queued Path B for the
   * whole order, same as a single-seat contention).
   */
  async acquireSeatLocks(seatIds: string[]): Promise<SeatLock[] | null> {
    const held: SeatLock[] = [];
    for (const seatId of [...seatIds].sort()) {
      const lock = await this.acquireSeatLock(seatId);
      if (!lock) {
        await this.releaseAll(held);
        return null;
      }
      held.push(lock);
    }
    return held;
  }

  async releaseAll(locks: SeatLock[]): Promise<void> {
    await Promise.all(locks.map((lock) => this.release(lock)));
  }
}
