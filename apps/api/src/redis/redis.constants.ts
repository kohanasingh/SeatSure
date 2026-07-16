// Token lives outside redis.module.ts so providers the module registers
// (e.g. CacheService) can import it without a circular module import.
export const REDIS_CLIENT = 'REDIS_CLIENT';
