import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { BookingsQueueModule } from '../queue/bookings-queue.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { BookingsService } from './bookings.service';
import { BookingsWorker } from './bookings.worker';
import { LockService } from './lock.service';
import { QueueStatsService } from './queue-stats.service';

@Module({
  imports: [PaymentsModule, BookingsQueueModule, RealtimeModule],
  providers: [BookingsService, BookingsWorker, LockService, QueueStatsService],
  exports: [BookingsService, QueueStatsService],
})
export class BookingsModule {}
