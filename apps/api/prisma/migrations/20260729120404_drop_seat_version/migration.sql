-- Seat.version was redundant with the status-based guarded UPDATE
-- (WHERE status='AVAILABLE'); status only ever transitions
-- AVAILABLE -> BOOKED in the booking path, so that condition already
-- gives the same compare-and-swap guarantee a version counter would.
-- See DECISIONS.md / ARCHITECTURE.md sec 4.
ALTER TABLE "Seat" DROP COLUMN "version";
