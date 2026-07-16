import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EventsModule } from '../events/events.module';
import { TrpcService } from './trpc.service';

@Module({
  imports: [AuthModule, EventsModule],
  providers: [TrpcService],
  exports: [TrpcService],
})
export class TrpcModule {}
