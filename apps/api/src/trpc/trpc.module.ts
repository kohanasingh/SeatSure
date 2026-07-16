import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BookingsModule } from '../bookings/bookings.module';
import { EventsModule } from '../events/events.module';
import { TrpcService } from './trpc.service';

@Module({
  imports: [AuthModule, EventsModule, BookingsModule],
  providers: [TrpcService],
  exports: [TrpcService],
})
export class TrpcModule {}
