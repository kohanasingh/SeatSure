import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import type { CreateBookingInput } from '@seatsure/shared';
import { Queue } from 'bullmq';
import type { AuthenticatedUser } from '../auth/types';
// type-only: the runtime dependency runs the other way (service → this module)
import type { BookingRequestMeta } from '../bookings/bookings.service';
import { bullPrefix, createBullConnection } from './events-queue.module';

export const BOOKINGS_QUEUE = 'BOOKINGS_QUEUE';
export const BOOKINGS_QUEUE_NAME = 'bookings';
export const PROCESS_BOOKING_JOB = 'process-booking';
export const SEND_CONFIRMATION_JOB = 'send-confirmation';

export interface ProcessBookingJobData {
  bookingId: string;
  user: AuthenticatedUser;
  input: CreateBookingInput;
  meta: BookingRequestMeta;
}

export interface SendConfirmationJobData {
  bookingId: string;
  email: string;
}

export type BookingsJobData = ProcessBookingJobData | SendConfirmationJobData;

@Global()
@Module({
  providers: [
    {
      provide: BOOKINGS_QUEUE,
      useFactory: (config: ConfigService): Queue<BookingsJobData> =>
        new Queue(BOOKINGS_QUEUE_NAME, {
          connection: createBullConnection(config),
          prefix: bullPrefix(config),
        }),
      inject: [ConfigService],
    },
  ],
  exports: [BOOKINGS_QUEUE],
})
export class BookingsQueueModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    await this.moduleRef.get<Queue>(BOOKINGS_QUEUE).close();
  }
}
