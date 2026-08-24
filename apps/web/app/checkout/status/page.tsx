'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { trpcQuery } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import { getSocket } from '../../../lib/socket';

type Status = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';

interface StatusResult {
  status: Status;
  failReason: string | null;
}

/**
 * Resolves every booking id in the order (one per seat for an ASSIGNED
 * checkout, a single id for GENERAL). Primary signal is the booking-status
 * socket push to the user room; a 2s poll of bookings.getStatus per id is
 * the fallback (ARCHITECTURE.md §2 Path B step 4). The whole order reads as
 * CONFIRMED only once every row has confirmed; one FAILED row is enough to
 * flag the order as failed.
 */
function StatusInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, loading } = useAuth();
  const ids = params.get('ids')?.split(',').filter(Boolean) ?? [];
  const [statuses, setStatuses] = useState<Record<string, StatusResult>>({});

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    if (!user || ids.length === 0) return;

    let stopped = false;
    const apply = (id: string, r: StatusResult) => {
      if (!stopped) setStatuses((prev) => ({ ...prev, [id]: r }));
    };

    const socket = getSocket();
    const onStatus = (p: { bookingId: string; status: Status; failReason?: string }) => {
      if (ids.includes(p.bookingId)) apply(p.bookingId, { status: p.status, failReason: p.failReason ?? null });
    };
    socket.on('booking-status', onStatus);

    const poll = async () => {
      await Promise.all(
        ids.map(async (id) => {
          try {
            apply(id, await trpcQuery<StatusResult>('bookings.getStatus', { bookingId: id }));
          } catch {
            // transient — next tick retries
          }
        }),
      );
    };
    void poll();
    const interval = setInterval(() => {
      void poll();
    }, 2_000);

    return () => {
      stopped = true;
      socket.off('booking-status', onStatus);
      clearInterval(interval);
    };
    // ids is derived fresh from params each render but stable in content for a given order
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, ids.join(',')]);

  if (ids.length === 0) {
    return <p className="p-8 text-slate-400">Missing booking reference.</p>;
  }

  const resolved = ids.map((id) => statuses[id]?.status);
  const allConfirmed = resolved.length === ids.length && resolved.every((s) => s === 'CONFIRMED');
  const anyFailed = resolved.some((s) => s === 'FAILED' || s === 'CANCELLED');
  const stillPending = !allConfirmed && !anyFailed;
  const failReason = ids.map((id) => statuses[id]?.failReason).find(Boolean);

  return (
    <main className="mx-auto max-w-md space-y-6 px-6 py-20 text-center">
      {stillPending ? (
        <>
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/10 border-t-fuchsia-400" />
          <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold text-white">
            Holding your spot…
          </h1>
          <p className="text-sm text-slate-400">
            High demand right now — your {ids.length > 1 ? 'order' : 'booking'} is in the queue and
            will confirm in a moment.
          </p>
        </>
      ) : allConfirmed ? (
        <>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-2xl text-emerald-300 ring-1 ring-emerald-400/30">
            ✓
          </div>
          <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold text-emerald-300" data-status="confirmed">
            {ids.length > 1 ? 'Order confirmed!' : 'Booking confirmed!'}
          </h1>
          <p className="text-sm text-slate-400">
            {ids.length > 1 ? `${ids.length} seats booked` : `Booking ref: ${ids[0]}`}
          </p>
          <Link href="/bookings" className="inline-block text-sm font-medium text-fuchsia-300 underline underline-offset-4">
            View my bookings
          </Link>
        </>
      ) : (
        <>
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-500/15 text-2xl text-rose-300 ring-1 ring-rose-400/30">
            ✕
          </div>
          <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold text-rose-300" data-status="failed">
            {ids.length > 1 ? 'Order failed' : 'Booking failed'}
          </h1>
          {failReason && <p className="text-sm text-slate-400">Reason: {failReason.replace(/_/g, ' ')}</p>}
          <Link href="/" className="inline-block text-sm font-medium text-fuchsia-300 underline underline-offset-4">
            Back to events
          </Link>
        </>
      )}
    </main>
  );
}

export default function BookingStatusPage() {
  return (
    <Suspense fallback={<p className="p-8 text-slate-400">Loading…</p>}>
      <StatusInner />
    </Suspense>
  );
}
