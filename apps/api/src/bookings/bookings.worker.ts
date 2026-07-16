import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import {
  BOOKINGS_QUEUE_NAME,
  BookingsJobData,
  PROCESS_BOOKING_JOB,
  ProcessBookingJobData,
  SEND_CONFIRMATION_JOB,
  SendConfirmationJobData,
} from '../queue/bookings-queue.module';
import { bullPrefix, createBullConnection } from '../queue/events-queue.module';
import { BookingsService } from './bookings.service';

/**
 * Path B executor (ARCHITECTURE.md §2): concurrency 10, 3 attempts,
 * exponential backoff from 1s. In-process for v1; registered as a provider so
 * extraction to its own container later is a config change, not a rewrite.
 */
@Injectable()
export class BookingsWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BookingsWorker.name);
  private worker?: Worker<BookingsJobData>;

  constructor(
    private readonly bookings: BookingsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<BookingsJobData>(
      BOOKINGS_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: createBullConnection(this.config),
        prefix: bullPrefix(this.config),
        concurrency: 10,
      },
    );

    this.worker.on('failed', (job, err) => {
      const requestId =
        job?.name === PROCESS_BOOKING_JOB
          ? ((job.data as ProcessBookingJobData).meta.requestId ?? 'n/a')
          : 'n/a';
      this.logger.warn(
        `Job ${job?.name} ${job?.id} attempt ${job?.attemptsMade} failed (req=${requestId}): ${err.message}`,
      );
      // Terminal failure after all attempts → booking flips to FAILED;
      // capacity/seat untouched (the transaction never committed).
      if (
        job?.name === PROCESS_BOOKING_JOB &&
        job.attemptsMade >= (job.opts.attempts ?? 1)
      ) {
        const data = job.data as ProcessBookingJobData;
        void this.bookings.failBooking(data.bookingId, data.user.id, 'RETRIES_EXHAUSTED');
      }
    });
  }

  private async process(job: Job<BookingsJobData>): Promise<void> {
    if (job.name === PROCESS_BOOKING_JOB) {
      const data = job.data as ProcessBookingJobData;
      const startedAt = Date.now();
      await this.bookings.processQueuedBooking(data);
      // req= carries the originating HTTP request id (pino genReqId) into
      // worker output — the §10 web → api → worker correlation
      this.logger.log(
        `processed booking ${data.bookingId} in ${Date.now() - startedAt}ms ` +
          `(attempt ${job.attemptsMade + 1}, req=${data.meta.requestId ?? 'n/a'})`,
      );
      return;
    }
    if (job.name === SEND_CONFIRMATION_JOB) {
      const data = job.data as SendConfirmationJobData;
      // mock email = log line (ARCHITECTURE.md §2 Path A step 5)
      this.logger.log(`[mock email] Booking ${data.bookingId} confirmed → ${data.email}`);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
