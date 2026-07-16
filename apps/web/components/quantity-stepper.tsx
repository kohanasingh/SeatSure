'use client';

import { useState } from 'react';
import { formatPrice } from '../lib/format';

const MAX_QTY = 8; // matches createBookingSchema

export function QuantityStepper({
  priceCents,
  remaining,
}: {
  priceCents: number;
  remaining: number;
}) {
  const [qty, setQty] = useState(1);
  const max = Math.min(MAX_QTY, remaining);
  const soldOut = remaining <= 0;

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 p-4">
      <p className="text-sm text-gray-600">
        {soldOut ? 'Sold out' : `${remaining} tickets remaining`}
      </p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            disabled={soldOut || qty <= 1}
            className="h-8 w-8 rounded-md border border-gray-300 font-medium disabled:opacity-40"
          >
            −
          </button>
          <span className="w-8 text-center font-semibold" data-qty>
            {qty}
          </span>
          <button
            type="button"
            onClick={() => setQty((q) => Math.min(max, q + 1))}
            disabled={soldOut || qty >= max}
            className="h-8 w-8 rounded-md border border-gray-300 font-medium disabled:opacity-40"
          >
            +
          </button>
        </div>
        <p className="text-sm">
          Total: <span className="font-semibold">{formatPrice(priceCents * qty)}</span>
        </p>
      </div>

      <button
        type="button"
        disabled
        title="Booking arrives in Phase 3"
        className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white opacity-50"
      >
        {soldOut ? 'Sold out' : 'Book tickets'}
      </button>
    </div>
  );
}
