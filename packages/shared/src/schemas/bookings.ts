import { z } from 'zod';

// client-reported form completion time — a fraud signal recorded on the
// transaction row, never trusted for anything else
const timeToComplete = z.number().int().min(0).max(3_600_000).optional();

export const createBookingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assigned'),
    eventId: z.string().uuid(),
    seatId: z.string().uuid(),
    timeToCompleteMs: timeToComplete,
  }),
  z.object({
    kind: z.literal('general'),
    eventId: z.string().uuid(),
    quantity: z.number().int().min(1).max(8),
    timeToCompleteMs: timeToComplete,
  }),
]);
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const bookingQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type BookingQueryInput = z.infer<typeof bookingQuerySchema>;
