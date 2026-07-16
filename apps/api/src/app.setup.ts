import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

/**
 * Pre-init middleware, ahead of every route: helmet → cookie-parser → CORS.
 * The tRPC handler is NOT mounted here — TrpcModule registers it as Nest
 * middleware so it runs after nestjs-pino's pino-http (request logs + req.id)
 * and before Nest's 404 catch-all. Shared by main.ts and the e2e harness.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  app.use(helmet()); // JSON API — default policy set is safe here
  app.use(cookieParser());
  app.enableCors({
    // strict: exactly the web origin, nothing reflected
    origin: config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000',
    credentials: true,
  });
}
