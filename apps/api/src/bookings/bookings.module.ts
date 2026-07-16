import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { BookingsService } from './bookings.service';
import { LockService } from './lock.service';

@Module({
  imports: [PaymentsModule],
  providers: [BookingsService, LockService],
  exports: [BookingsService],
})
export class BookingsModule {}
