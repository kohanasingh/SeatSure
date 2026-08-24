import { z } from 'zod';

// client-reported form completion time — a fraud signal recorded on the
// transaction row, never trusted for anything else
const timeToComplete = z.number().int().min(0).max(3_600_000).optional();

// Absolute ceiling regardless of an event's maxSeatsPerOrder — even an
// "unrestricted" event is bounded by this (real ticketing platforms always
// have some hard cap; this also keeps the multi-seat transaction's lock
// fan-out bounded).
export const MAX_SEATS_PER_ORDER_HARD_CAP = 12;

export const createBookingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('assigned'),
    eventId: z.string().uuid(),
    seatIds: z.array(z.string().uuid()).min(1).max(MAX_SEATS_PER_ORDER_HARD_CAP),
    timeToCompleteMs: timeToComplete,
  }),
  z.object({
    kind: z.literal('general'),
    eventId: z.string().uuid(),
    quantity: z.number().int().min(1).max(8),
    timeToCompleteMs: timeToComplete,
  }),
]).refine(
  (input) => input.kind !== 'assigned' || new Set(input.seatIds).size === input.seatIds.length,
  { message: 'Duplicate seatIds in one order' },
);
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const bookingQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type BookingQueryInput = z.infer<typeof bookingQuerySchema>;
