import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Sliding-window limiter (spec §5: `rl:<route>:<key>`): a Redis ZSET of
 * request timestamps per key; entries older than the window are trimmed on
 * each request. Shared by the /auth/* guard (per IP) and bookings.create
 * (per user).
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Records a hit and returns true when the key is within its limit. */
  async consume(key: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const [, , count] = await this.redis
      .multi()
      .zremrangebyscore(key, 0, now - windowMs)
      .zadd(key, now, `${now}:${randomUUID()}`)
      .zcard(key)
      .pexpire(key, windowMs)
      .exec()
      .then((results) => (results ?? []).map(([, value]) => value));
    return Number(count) <= max;
  }
}
