import { z } from 'zod';

const eventBase = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  venue: z.string().max(200).optional(),
  eventTime: z.coerce.date(),
  onSaleAt: z.coerce.date(),
});

export const seatLayoutSchema = z.object({
  rows: z.number().int().min(1).max(26), // rows labeled A–Z
  seatsPerRow: z.number().int().min(1).max(100),
  priceCents: z.number().int().positive(),
});
export type SeatLayoutInput = z.infer<typeof seatLayoutSchema>;

export const createEventSchema = z.discriminatedUnion('seatingType', [
  eventBase.extend({
    seatingType: z.literal('ASSIGNED'),
    seatLayout: seatLayoutSchema,
  }),
  eventBase.extend({
    seatingType: z.literal('GENERAL'),
    totalCapacity: z.number().int().min(1).max(100_000),
    gaPriceCents: z.number().int().positive(),
  }),
]);
export type CreateEventInput = z.infer<typeof createEventSchema>;

// Partial edits to non-structural fields; seatingType/layout/capacity are
// immutable after creation (changing them would orphan or contradict seats).
export const updateEventSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  venue: z.string().max(200).optional(),
  eventTime: z.coerce.date().optional(),
  onSaleAt: z.coerce.date().optional(),
});
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const eventQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type EventQueryInput = z.infer<typeof eventQuerySchema>;
