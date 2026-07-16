'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { trpcQuery } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import { getSocket } from '../../../lib/socket';

type Status = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';

interface StatusResult {
  status: Status;
  failReason: string | null;
}

/**
 * Pending → confirmed resolution: primary signal is the booking-status socket
 * push to the user room; a 2s poll of bookings.getStatus is the fallback
 * (ARCHITECTURE.md §2 Path B step 4).
 */
export default function BookingStatusPage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const router = useRouter();
  const { user, loading } = useAuth();
  const [result, setResult] = useState<StatusResult | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    if (!user || !bookingId) return;

    let stopped = false;
    const apply = (r: StatusResult) => {
      if (!stopped) setResult(r);
    };

    const socket = getSocket();
    const onStatus = (p: { bookingId: string; status: Status; failReason?: string }) => {
      if (p.bookingId === bookingId) apply({ status: p.status, failReason: p.failReason ?? null });
    };
    socket.on('booking-status', onStatus);

    const poll = async () => {
      try {
        apply(await trpcQuery<StatusResult>('bookings.getStatus', { bookingId }));
      } catch {
        // transient — next tick retries
      }
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
  }, [user, bookingId]);

  const status = result?.status;

  return (
    <main className="mx-auto max-w-md space-y-6 p-6 text-center">
      {!status || status === 'PENDING' ? (
        <>
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-gray-900" />
          <h1 className="text-xl font-semibold">Holding your spot…</h1>
          <p className="text-sm text-gray-600">
            High demand right now — your booking is in the queue and will confirm in a moment.
          </p>
        </>
      ) : status === 'CONFIRMED' ? (
        <>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-2xl">
            ✓
          </div>
          <h1 className="text-xl font-semibold text-green-700" data-status="confirmed">
            Booking confirmed!
          </h1>
          <p className="text-sm text-gray-600">Booking ref: {bookingId}</p>
          <Link href="/bookings" className="inline-block text-sm font-medium underline">
            View my bookings
          </Link>
        </>
      ) : (
        <>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-2xl">
            ✕
          </div>
          <h1 className="text-xl font-semibold text-red-700" data-status="failed">
            Booking {status === 'FAILED' ? 'failed' : 'cancelled'}
          </h1>
          {result?.failReason && (
            <p className="text-sm text-gray-600">Reason: {result.failReason.replace(/_/g, ' ')}</p>
          )}
          <Link href="/" className="inline-block text-sm font-medium underline">
            Back to events
          </Link>
        </>
      )}
    </main>
  );
}
