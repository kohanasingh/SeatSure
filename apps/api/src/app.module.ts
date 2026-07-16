import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { BookingsModule } from './bookings/bookings.module';
import { validateEnv } from './config/env.validation';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { RealtimeModule } from './realtime/realtime.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { TrpcModule } from './trpc/trpc.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // apps run with CWD=apps/<app>; fall back to a repo-root .env if present
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv, // fail fast on a misconfigured environment
    }),
    // Structured JSON logging with request IDs (ARCHITECTURE.md §10); the id
    // rides the tRPC context into queue jobs so worker lines correlate.
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        autoLogging: {
          ignore: (req) => req.url === '/health' || req.url === '/ready',
        },
        level: process.env.NODE_ENV === 'test' ? 'warn' : 'info',
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    EventsModule,
    BookingsModule,
    RealtimeModule,
    TrpcModule,
  ],
})
export class AppModule {}
