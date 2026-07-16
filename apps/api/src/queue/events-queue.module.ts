import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

export const EVENTS_QUEUE = 'EVENTS_QUEUE';
export const EVENTS_QUEUE_NAME = 'events';
export const FLIP_ON_SALE_JOB = 'flip-on-sale';
// BullMQ forbids ':' in custom job ids
export const flipJobId = (eventId: string): string => `${FLIP_ON_SALE_JOB}-${eventId}`;

export interface FlipOnSaleJobData {
  eventId: string;
}

// BullMQ requires maxRetriesPerRequest: null (blocking commands), so it gets
// its own connections rather than reusing REDIS_CLIENT.
export const createBullConnection = (config: ConfigService): Redis =>
  new Redis(config.getOrThrow<string>('REDIS_URL'), { maxRetriesPerRequest: null });

@Global()
@Module({
  providers: [
    {
      provide: EVENTS_QUEUE,
      useFactory: (config: ConfigService): Queue<FlipOnSaleJobData> =>
        new Queue(EVENTS_QUEUE_NAME, { connection: createBullConnection(config) }),
      inject: [ConfigService],
    },
  ],
  exports: [EVENTS_QUEUE],
})
export class EventsQueueModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    await this.moduleRef.get<Queue>(EVENTS_QUEUE).close();
  }
}
