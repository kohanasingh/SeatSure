import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the default transform (oxc) cannot emit decorator metadata, which
  // NestJS DI requires — swc can.
  oxc: false,
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    hookTimeout: 60_000,
    testTimeout: 30_000,
    fileParallelism: false, // suites share one Postgres/Redis
    env: {
      // keep the limiter code paths active but out of the way of the suite
      RATE_LIMIT_AUTH_MAX: '10000',
      RATE_LIMIT_BOOKING_MAX: '10000',
      // isolate test queues from any running dev server sharing this Redis
      BULLMQ_PREFIX: 'bull-e2e',
    },
  },
});
