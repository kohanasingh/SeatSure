'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../lib/auth-context';
import { formatPrice } from '../lib/format';
import { getSocket } from '../lib/socket';

export interface SeatInfo {
  id: string;
  seatNumber: string;
  priceCents: number;
  status: 'AVAILABLE' | 'BOOKED';
}

/** "A12" → row "A" (for grouping into visual rows). */
const rowOf = (seatNumber: string): string => /^[A-Z]+/.exec(seatNumber)?.[0] ?? '?';

export function SeatGrid({
  eventId,
  seats: initial,
  maxSeatsPerOrder,
}: {
  eventId: string;
  seats: SeatInfo[];
  /** null = unrestricted (still bounded by the shared hard cap, applied server-side). */
  maxSeatsPerOrder: number | null;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const [seats, setSeats] = useState(initial);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Live availability (ARCHITECTURE.md §6): join the event room and flip
  // seats as seat-updated pushes arrive. Sockets are downstream-only.
  useEffect(() => {
    const socket = getSocket();
    const onSeatUpdated = ({ seatId, status }: { seatId: string; status: SeatInfo['status'] }) => {
      setSeats((prev) => prev.map((s) => (s.id === seatId ? { ...s, status } : s)));
      setSelectedIds((sel) => (status === 'BOOKED' ? sel.filter((id) => id !== seatId) : sel));
    };
    socket.emit('join-event', eventId);
    socket.on('seat-updated', onSeatUpdated);
    return () => {
      socket.emit('leave-event', eventId);
      socket.off('seat-updated', onSeatUpdated);
    };
  }, [eventId]);

  const rows = useMemo(() => {
    const grouped = new Map<string, SeatInfo[]>();
    for (const seat of seats) {
      const row = rowOf(seat.seatNumber);
      grouped.set(row, [...(grouped.get(row) ?? []), seat]);
    }
    return [...grouped.entries()];
  }, [seats]);

  const selected = seats.filter((s) => selectedIds.includes(s.id));
  const total = selected.reduce((sum, s) => sum + s.priceCents, 0);
  const atLimit = maxSeatsPerOrder != null && selectedIds.length >= maxSeatsPerOrder;

  const toggle = (seatId: string) => {
    setSelectedIds((sel) => {
      if (sel.includes(seatId)) return sel.filter((id) => id !== seatId);
      if (maxSeatsPerOrder != null && sel.length >= maxSeatsPerOrder) return sel;
      return [...sel, seatId];
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-emerald-500" /> Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-slate-600" /> Booked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-fuchsia-500" /> Selected
        </span>
        <span className="ml-auto rounded-full border border-white/10 bg-white/5 px-3 py-1 font-medium text-slate-200">
          {maxSeatsPerOrder != null ? `Up to ${maxSeatsPerOrder} seats per order` : 'No limit per order'}
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-black/20 p-4 pb-3 backdrop-blur-sm">
        <div className="mb-3 text-center text-[10px] uppercase tracking-[0.3em] text-slate-400">Stage</div>
        <div className="mx-auto inline-flex flex-col gap-1.5">
          {rows.map(([row, rowSeats]) => (
            <div key={row} className="flex items-center gap-1.5">
              <span className="w-5 text-right font-mono text-xs text-slate-500">{row}</span>
              {rowSeats.map((seat) => {
                const isSelected = selectedIds.includes(seat.id);
                const booked = seat.status === 'BOOKED';
                const disabled = booked || (!isSelected && atLimit);
                return (
                  <button
                    key={seat.id}
                    type="button"
                    data-seat
                    disabled={disabled}
                    onClick={() => toggle(seat.id)}
                    title={`${seat.seatNumber} — ${booked ? 'booked' : formatPrice(seat.priceCents)}`}
                    className={`h-6 w-6 rounded-sm text-[9px] font-medium text-white transition-all ${
                      booked
                        ? 'cursor-not-allowed bg-slate-700'
                        : isSelected
                          ? 'scale-110 bg-fuchsia-500 shadow-[0_0_10px_rgba(217,70,239,0.7)]'
                          : disabled
                            ? 'cursor-not-allowed bg-emerald-800/50'
                            : 'bg-emerald-500 hover:scale-110 hover:bg-emerald-400'
                    }`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm">
          {selected.length === 0 ? (
            <span className="text-slate-400">
              Select a seat{maxSeatsPerOrder !== 1 ? ' or seats' : ''}
            </span>
          ) : (
            <>
              <span className="font-semibold text-white">
                {selected.length} seat{selected.length > 1 ? 's' : ''}
              </span>
              <span className="text-slate-400"> — {selected.map((s) => s.seatNumber).join(', ')}</span>
              <span className="ml-2 font-semibold text-fuchsia-300">{formatPrice(total)}</span>
            </>
          )}
        </div>
        {user ? (
          <button
            type="button"
            disabled={selected.length === 0}
            onClick={() =>
              selected.length > 0 &&
              router.push(`/checkout?eventId=${eventId}&seatIds=${selected.map((s) => s.id).join(',')}`)
            }
            className="rounded-full bg-fuchsia-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/30 transition-transform hover:scale-105 hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
          >
            {selected.length > 1 ? `Book ${selected.length} seats` : 'Book seat'}
          </button>
        ) : (
          <Link
            href="/login"
            className="rounded-full bg-fuchsia-500 px-5 py-2.5 text-center text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/30 transition-transform hover:scale-105 hover:bg-fuchsia-400"
          >
            Log in to book
          </Link>
        )}
      </div>
    </div>
  );
}
