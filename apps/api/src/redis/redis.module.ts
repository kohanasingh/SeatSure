import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';
import { CacheService } from './cache.service';
import { RateLimitService } from './rate-limit.service';
import { REDIS_CLIENT } from './redis.constants';

export { REDIS_CLIENT } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService): Redis =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          // fail fast instead of queueing commands forever when Redis is down
          maxRetriesPerRequest: 2,
        }),
      inject: [ConfigService],
    },
    CacheService,
    RateLimitService,
  ],
  exports: [REDIS_CLIENT, CacheService, RateLimitService],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT);
    await client.quit();
  }
}
