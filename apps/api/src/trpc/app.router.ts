import { protectedProcedure, roleProcedure, router } from './trpc';

// Grows in later phases (events, bookings, admin.createEvent, …).
export const appRouter = router({
  auth: router({
    me: protectedProcedure.query(({ ctx }) => ctx.user),
  }),
  admin: router({
    ping: roleProcedure('ORGANIZER', 'ADMIN').query(() => ({ pong: true })),
  }),
});

export type AppRouter = typeof appRouter;
