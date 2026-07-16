import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { TrpcService } from './trpc/trpc.service';

/** Shared between main.ts and the e2e test harness so both run the same app. */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  app.use(cookieParser());
  app.enableCors({
    origin: config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000',
    credentials: true,
  });
  app.use('/trpc', app.get(TrpcService).middleware());
}
