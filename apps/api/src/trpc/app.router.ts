import { createEventSchema, eventQuerySchema, updateEventSchema } from '@seatsure/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { EventsAdminService } from '../events/events-admin.service';
import { EventsService } from '../events/events.service';
import { protectedProcedure, publicProcedure, roleProcedure, router } from './trpc';

export interface RouterDeps {
  events: EventsService;
  admin: EventsAdminService;
}

const organizerProcedure = roleProcedure('ORGANIZER', 'ADMIN');

export const createAppRouter = (deps: RouterDeps) =>
  router({
    auth: router({
      me: protectedProcedure.query(({ ctx }) => ctx.user),
    }),
    events: router({
      list: publicProcedure
        .input(eventQuerySchema)
        .query(({ input }) => deps.events.list(input)),
      byId: publicProcedure
        .input(z.object({ id: z.string().uuid() }))
        .query(async ({ input }) => {
          const event = await deps.events.byId(input.id);
          if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
          return event;
        }),
      seatMap: publicProcedure
        .input(z.object({ eventId: z.string().uuid() }))
        .query(({ input }) => deps.events.seatMap(input.eventId)),
    }),
    admin: router({
      ping: organizerProcedure.query(() => ({ pong: true })),
      createEvent: organizerProcedure
        .input(createEventSchema)
        .mutation(({ input, ctx }) => deps.admin.createEvent(input, ctx.user.id)),
      updateEvent: organizerProcedure
        .input(updateEventSchema)
        .mutation(({ input, ctx }) => deps.admin.updateEvent(input, ctx.user)),
    }),
  });

export type AppRouter = ReturnType<typeof createAppRouter>;
