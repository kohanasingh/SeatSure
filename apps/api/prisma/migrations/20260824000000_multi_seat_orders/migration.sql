-- Per-order seat cap for ASSIGNED events (null = unrestricted, still bounded
-- by the shared zod schema's hard cap). Ignored for GENERAL events.
ALTER TABLE "Event" ADD COLUMN "maxSeatsPerOrder" INTEGER;

-- Groups sibling Booking rows created by one multi-seat ASSIGNED checkout
-- (still one row per seat, so per-seat queries/indexes are unaffected).
ALTER TABLE "Booking" ADD COLUMN "orderId" TEXT;

-- CreateIndex
CREATE INDEX "Booking_orderId_idx" ON "Booking"("orderId");
