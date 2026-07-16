import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BookingsModule } from '../bookings/bookings.module';
import { EventsModule } from '../events/events.module';
import { TrpcService } from './trpc.service';

@Module({
  imports: [AuthModule, EventsModule, BookingsModule],
  providers: [TrpcService],
  exports: [TrpcService],
})
export class TrpcModule implements NestModule {
  constructor(private readonly trpc: TrpcService) {}

  // Registered as Nest middleware (not a raw app.use) so it sits AFTER
  // nestjs-pino's pino-http — /trpc requests get logged and carry req.id —
  // and BEFORE Nest's 404 catch-all. Nest mounts consumer middleware the way
  // app.use(path, …) does: the matched prefix is already stripped from
  // req.url, which is exactly what the tRPC express adapter expects.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.trpc.middleware()).forRoutes('trpc', 'trpc/*splat');
  }
}
