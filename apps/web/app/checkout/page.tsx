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
  const seatIds = useMemo(
    () => params.get('seatIds')?.split(',').filter(Boolean) ?? [],
    [params],
  );
  const qty = Number(params.get('qty') ?? 1);
  const isAssigned = seatIds.length > 0;

  // one key per checkout attempt: a double-click or network retry can never
  // double-book (idempotency layer returns the same order)
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const mountedAt = useRef(Date.now());

  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [seatLabels, setSeatLabels] = useState<string[]>([]);
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
      setEventTitle(event.title);
      if (isAssigned) {
        const seats = await trpc.events.seatMap.query({ eventId });
        const picked = seats.filter((s) => seatIds.includes(s.id));
        setSeatLabels(picked.map((s) => s.seatNumber));
        setAmount(picked.reduce((sum, s) => sum + s.priceCents, 0));
      } else {
        setAmount((event.gaPriceCents ?? 0) * qty);
      }
    })();
  }, [eventId, seatIds, isAssigned, qty]);

  if (!eventId || (!isAssigned && !params.get('qty'))) {
    return <p className="p-8 text-slate-400">Missing checkout parameters.</p>;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const input = isAssigned
        ? { kind: 'assigned', eventId, seatIds, timeToCompleteMs: Date.now() - mountedAt.current }
        : { kind: 'general', eventId, quantity: qty, timeToCompleteMs: Date.now() - mountedAt.current };
      const bookings = await trpcMutate<BookingResult[]>('bookings.create', input, {
        'Idempotency-Key': idempotencyKey,
      });
      const ids = bookings.map((b) => b.id).join(',');
      router.replace(`/checkout/status?ids=${ids}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
      setSubmitting(false);
    }
  }

  const summary = isAssigned
    ? `${eventTitle ?? 'Loading…'}${seatLabels.length ? ` — seat${seatLabels.length > 1 ? 's' : ''} ${seatLabels.join(', ')}` : ''}`
    : `${eventTitle ?? 'Loading…'} — ${qty} ticket${qty > 1 ? 's' : ''}`;

  return (
    <main className="mx-auto max-w-md space-y-6 px-6 py-16">
      <div className="text-center">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold tracking-tight text-white">
          Checkout
        </h1>
        <p className="mt-1 text-sm text-slate-400">Mock payment — nothing is actually charged.</p>
      </div>

      <div className="glass rounded-2xl p-5 text-sm">
        <p className="font-medium text-white">{summary}</p>
        {amount !== null && (
          <p className="mt-2 text-lg font-semibold text-fuchsia-300">Total: {formatPrice(amount)}</p>
        )}
      </div>

      {/* Mock payment form — nothing here is real or sent anywhere except
          the completion time (a fraud signal on the transaction row). */}
      <form onSubmit={onSubmit} className="glass space-y-4 rounded-2xl p-5">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-300">Name on card</span>
          <input
            value={cardName}
            onChange={(e) => setCardName(e.target.value)}
            required
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-fuchsia-400 focus:outline-none"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-300">Card number (mock)</span>
          <input
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value)}
            placeholder="4242 4242 4242 4242"
            required
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-fuchsia-400 focus:outline-none"
          />
        </label>

        {error && <p className="text-sm text-rose-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting || !user}
          className="w-full rounded-full bg-fuchsia-500 px-3 py-2.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/30 transition-transform hover:scale-[1.02] hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
        >
          {submitting ? 'Processing…' : amount !== null ? `Pay ${formatPrice(amount)}` : 'Pay'}
        </button>
      </form>
    </main>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={<p className="p-8 text-slate-400">Loading…</p>}>
      <CheckoutForm />
    </Suspense>
  );
}
