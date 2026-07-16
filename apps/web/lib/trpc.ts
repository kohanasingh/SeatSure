import type { AppRouter } from '@seatsure/api/trpc';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

// Type-only import of the API's router — full end-to-end types, zero runtime
// coupling. Used from server components (SSR); public read procedures only.
export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/trpc`,
    }),
  ],
});
