import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; postgres: string; redis: string }> {
    const [pg, rd] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
    ]);
    const postgres = pg.status === 'fulfilled' ? 'up' : 'down';
    const redis = rd.status === 'fulfilled' ? 'up' : 'down';

    if (postgres !== 'up' || redis !== 'up') {
      throw new ServiceUnavailableException({ status: 'not-ready', postgres, redis });
    }
    return { status: 'ready', postgres, redis };
  }
}
