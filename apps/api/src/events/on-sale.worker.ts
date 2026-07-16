import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  EVENTS_QUEUE_NAME,
  FLIP_ON_SALE_JOB,
  FlipOnSaleJobData,
  bullPrefix,
  createBullConnection,
} from '../queue/events-queue.module';
import { EventsService } from './events.service';

/**
 * The "tickets drop at noon" mechanism (ARCHITECTURE.md §8): a delayed job
 * scheduled for onSaleAt flips DRAFT → ON_SALE and busts the events cache.
 * In-process worker for v1, registered as a provider so extracting it later
 * is a config change.
 */
@Injectable()
export class OnSaleWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OnSaleWorker.name);
  private worker?: Worker<FlipOnSaleJobData>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<FlipOnSaleJobData>(
      EVENTS_QUEUE_NAME,
      (job) => this.process(job),
      { connection: createBullConnection(this.config), prefix: bullPrefix(this.config) },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.name} ${job?.id} failed: ${err.message}`);
    });
  }

  private async process(job: Job<FlipOnSaleJobData>): Promise<void> {
    if (job.name !== FLIP_ON_SALE_JOB) return;
    const { eventId } = job.data;

    // Guarded update: only DRAFT flips, so a stale/duplicate job is a no-op.
    const { count } = await this.prisma.event.updateMany({
      where: { id: eventId, status: 'DRAFT' },
      data: { status: 'ON_SALE' },
    });
    if (count === 1) {
      await this.events.bustCaches(eventId);
      this.logger.log(`Event ${eventId} flipped DRAFT -> ON_SALE`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
