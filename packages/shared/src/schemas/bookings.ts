import { z } from 'zod';

export const createBookingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assigned'),
    eventId: z.string().uuid(),
    seatId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('general'),
    eventId: z.string().uuid(),
    quantity: z.number().int().min(1).max(8),
  }),
]);
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
