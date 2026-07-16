import { randomUUID } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Sliding-window limiter (spec §5: `rl:<route>:<ip>`): a Redis ZSET of request
 * timestamps per IP; entries older than the window are trimmed on each request.
 * Limit is env-tunable (RATE_LIMIT_AUTH_MAX, default 10) so the test suite can
 * raise it without disabling the guard.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip ?? 'unknown';
    const key = `rl:auth:${ip}`;
    const now = Date.now();
    const max = Number(this.config.get('RATE_LIMIT_AUTH_MAX') ?? 10);

    const [, , countResult] = await this.redis
      .multi()
      .zremrangebyscore(key, 0, now - WINDOW_MS)
      .zadd(key, now, `${now}:${randomUUID()}`)
      .zcard(key)
      .pexpire(key, WINDOW_MS)
      .exec()
      .then((results) => (results ?? []).map(([, value]) => value));

    if (Number(countResult) > max) {
      throw new HttpException('Too many requests, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
