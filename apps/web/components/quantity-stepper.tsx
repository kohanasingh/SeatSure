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
    <div className="glass space-y-4 rounded-2xl p-5">
      <p className="text-sm text-slate-300" data-remaining>
        {soldOut ? 'Sold out' : `${remaining} tickets remaining`}
      </p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            disabled={soldOut || qty <= 1}
            className="h-9 w-9 rounded-full border border-white/15 font-medium text-white hover:bg-white/5 disabled:opacity-40"
          >
            −
          </button>
          <span className="w-8 text-center font-semibold text-white" data-qty>
            {qty}
          </span>
          <button
            type="button"
            onClick={() => setQty((q) => Math.min(max, q + 1))}
            disabled={soldOut || qty >= max}
            className="h-9 w-9 rounded-full border border-white/15 font-medium text-white hover:bg-white/5 disabled:opacity-40"
          >
            +
          </button>
        </div>
        <p className="text-sm text-slate-300">
          Total: <span className="font-semibold text-fuchsia-300">{formatPrice(priceCents * qty)}</span>
        </p>
      </div>

      {user ? (
        <button
          type="button"
          disabled={soldOut}
          onClick={() => router.push(`/checkout?eventId=${eventId}&qty=${qty}`)}
          className="w-full rounded-full bg-fuchsia-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/30 transition-transform hover:scale-[1.02] hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
        >
          {soldOut ? 'Sold out' : 'Book tickets'}
        </button>
      ) : (
        <Link
          href="/login"
          className="block w-full rounded-full bg-fuchsia-500 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/30 hover:bg-fuchsia-400"
        >
          Log in to book
        </Link>
      )}
    </div>
  );
}
