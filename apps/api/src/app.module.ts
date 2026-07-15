import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // apps run with CWD=apps/<app>; fall back to a repo-root .env if present
      envFilePath: ['.env', '../../.env'],
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
  ],
})
export class AppModule {}
