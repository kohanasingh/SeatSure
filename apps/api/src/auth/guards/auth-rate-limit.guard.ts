import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { RateLimitService } from '../../redis/rate-limit.service';

const WINDOW_MS = 15 * 60 * 1000;

/** /auth/* limit: 10 req / 15 min / IP (spec §3), env-tunable for tests. */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly rateLimit: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const max = Number(this.config.get('RATE_LIMIT_AUTH_MAX') ?? 10);

    const allowed = await this.rateLimit.consume(
      `rl:auth:${request.ip ?? 'unknown'}`,
      max,
      WINDOW_MS,
    );
    if (!allowed) {
      throw new HttpException('Too many requests, try again later', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
