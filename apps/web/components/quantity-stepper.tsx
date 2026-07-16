'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth-context';
import { formatPrice } from '../lib/format';
import { getSocket } from '../lib/socket';

const MAX_QTY = 8; // matches createBookingSchema

export function QuantityStepper({
  eventId,
  priceCents,
  remaining: initialRemaining,
}: {
  eventId: string;
  priceCents: number;
  remaining: number;
}) {
  const router = useRouter();
  const { user } = useAuth();
  const [qty, setQty] = useState(1);
  const [remaining, setRemaining] = useState(initialRemaining);

  useEffect(() => {
    const socket = getSocket();
    const onCapacity = (payload: { eventId: string; remaining: number }) => {
      if (payload.eventId === eventId) setRemaining(payload.remaining);
    };
    socket.emit('join-event', eventId);
    socket.on('capacity-updated', onCapacity);
    return () => {
      socket.emit('leave-event', eventId);
      socket.off('capacity-updated', onCapacity);
    };
  }, [eventId]);

  const max = Math.min(MAX_QTY, remaining);
  const soldOut = remaining <= 0;

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 p-4">
      <p className="text-sm text-gray-600" data-remaining>
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

      {user ? (
        <button
          type="button"
          disabled={soldOut}
          onClick={() => router.push(`/checkout?eventId=${eventId}&qty=${qty}`)}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {soldOut ? 'Sold out' : 'Book tickets'}
        </button>
      ) : (
        <Link
          href="/login"
          className="block w-full rounded-md bg-gray-900 px-4 py-2 text-center text-sm font-medium text-white hover:bg-gray-700"
        >
          Log in to book
        </Link>
      )}
    </div>
  );
}
