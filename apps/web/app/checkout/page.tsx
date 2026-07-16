'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, trpcMutate } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { formatPrice } from '../../lib/format';
import { trpc } from '../../lib/trpc';

interface BookingResult {
  id: string;
  status: string;
}

function CheckoutForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading } = useAuth();

  const eventId = params.get('eventId');
  const seatId = params.get('seatId');
  const qty = Number(params.get('qty') ?? 1);

  // one key per checkout attempt: a double-click or network retry can never
  // double-book (idempotency layer returns the same booking)
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const mountedAt = useRef(Date.now());

  const [summary, setSummary] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [cardName, setCardName] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    if (!eventId) return;
    void (async () => {
      const event = await trpc.events.byId.query({ id: eventId });
      if (seatId) {
        const seats = await trpc.events.seatMap.query({ eventId });
        const seat = seats.find((s) => s.id === seatId);
        setSummary(`${event.title} — seat ${seat?.seatNumber ?? '?'}`);
        setAmount(seat?.priceCents ?? null);
      } else {
        setSummary(`${event.title} — ${qty} ticket${qty > 1 ? 's' : ''}`);
        setAmount((event.gaPriceCents ?? 0) * qty);
      }
    })();
  }, [eventId, seatId, qty]);

  if (!eventId || (!seatId && !params.get('qty'))) {
    return <p className="p-8 text-gray-600">Missing checkout parameters.</p>;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const input = seatId
        ? { kind: 'assigned', eventId, seatId, timeToCompleteMs: Date.now() - mountedAt.current }
        : { kind: 'general', eventId, quantity: qty, timeToCompleteMs: Date.now() - mountedAt.current };
      const booking = await trpcMutate<BookingResult>('bookings.create', input, {
        'Idempotency-Key': idempotencyKey,
      });
      router.replace(`/checkout/${booking.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-md space-y-6 p-6">
      <h1 className="text-2xl font-bold tracking-tight">Checkout</h1>
      <div className="rounded-lg border border-gray-200 p-4 text-sm">
        <p className="font-medium">{summary ?? 'Loading…'}</p>
        {amount !== null && <p className="mt-1 text-gray-600">Total: {formatPrice(amount)}</p>}
      </div>

      {/* Mock payment form — nothing here is real or sent anywhere except
          the completion time (a fraud signal on the transaction row). */}
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Name on card</span>
          <input
            value={cardName}
            onChange={(e) => setCardName(e.target.value)}
            required
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Card number (mock)</span>
          <input
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value)}
            placeholder="4242 4242 4242 4242"
            required
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting || !user}
          className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {submitting ? 'Processing…' : amount !== null ? `Pay ${formatPrice(amount)}` : 'Pay'}
        </button>
      </form>
    </main>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<p className="p-8 text-gray-600">Loading…</p>}>
      <CheckoutForm />
    </Suspense>
  );
}
