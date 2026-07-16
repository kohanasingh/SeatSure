import { z } from 'zod';

// Fail fast at boot on a misconfigured environment — part of the Phase 5
// "Zod validation at every boundary" audit. Optional vars get their defaults
// where they are consumed; only genuinely required config is enforced here.
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_ACCESS_TTL: z.string().regex(/^\d+[smhd]$/).default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(7),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SIMULATE_PAYMENT_LATENCY_MS: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_BOOKING_MAX: z.coerce.number().int().min(1).default(10),
  BULLMQ_PREFIX: z.string().default('bull'),
});

export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  // parsed values win (coercions, defaults); everything else passes through
  return { ...config, ...result.data };
}
