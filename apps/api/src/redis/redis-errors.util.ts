const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * True for ioredis errors caused by Redis being unreachable or unresponsive
 * (connection refused/reset/timed out, or `maxRetriesPerRequest` exhausted
 * per redis.module.ts) — distinct from application-level Redis errors (bad
 * command, wrong type, etc.), which should surface normally.
 */
export const isRedisUnavailableError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  if (err.name === 'MaxRetriesPerRequestError' || err.name === 'AbortError') return true;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
};
