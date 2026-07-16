import type { AppRouter } from '@seatsure/api/trpc';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

// Type-only import of the API's router — full end-to-end types, zero runtime
// coupling. Used from server components (SSR); public read procedures only.
// SSR runs inside the compose network, so it prefers the internal API URL
// (e.g. http://api:3001) over the browser-facing NEXT_PUBLIC_API_URL.
const apiUrl =
  process.env.API_URL_INTERNAL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:3001';

export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${apiUrl}/trpc` })],
});
