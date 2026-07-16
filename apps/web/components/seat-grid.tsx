'use client';

import { useMemo, useState } from 'react';
import { formatPrice } from '../lib/format';

export interface SeatInfo {
  id: string;
  seatNumber: string;
  priceCents: number;
  status: 'AVAILABLE' | 'BOOKED';
}

/** "A12" → row "A" (for grouping into visual rows). */
const rowOf = (seatNumber: string): string => /^[A-Z]+/.exec(seatNumber)?.[0] ?? '?';

export function SeatGrid({ seats }: { seats: SeatInfo[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const grouped = new Map<string, SeatInfo[]>();
    for (const seat of seats) {
      const row = rowOf(seat.seatNumber);
      grouped.set(row, [...(grouped.get(row) ?? []), seat]);
    }
    return [...grouped.entries()];
  }, [seats]);

  const selected = seats.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex gap-4 text-xs text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-green-500" /> Available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-gray-400" /> Booked
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-blue-600" /> Selected
        </span>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="inline-flex flex-col gap-1.5">
          {rows.map(([row, rowSeats]) => (
            <div key={row} className="flex items-center gap-1.5">
              <span className="w-5 text-right font-mono text-xs text-gray-500">{row}</span>
              {rowSeats.map((seat) => {
                const isSelected = seat.id === selectedId;
                const booked = seat.status === 'BOOKED';
                return (
                  <button
                    key={seat.id}
                    type="button"
                    data-seat
                    disabled={booked}
                    onClick={() => setSelectedId(isSelected ? null : seat.id)}
                    title={`${seat.seatNumber} — ${booked ? 'booked' : formatPrice(seat.priceCents)}`}
                    className={`h-6 w-6 rounded-sm text-[9px] font-medium text-white transition-colors ${
                      booked
                        ? 'cursor-not-allowed bg-gray-400'
                        : isSelected
                          ? 'bg-blue-600'
                          : 'bg-green-500 hover:bg-green-600'
                    }`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
        <p className="text-sm">
          {selected ? (
            <>
              Seat <span className="font-semibold">{selected.seatNumber}</span> —{' '}
              <span className="font-semibold">{formatPrice(selected.priceCents)}</span>
            </>
          ) : (
            <span className="text-gray-600">Select a seat</span>
          )}
        </p>
        <button
          type="button"
          disabled
          title="Booking arrives in Phase 3"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white opacity-50"
        >
          Book seat
        </button>
      </div>
    </div>
  );
}
