'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { trpcQuery } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { formatDateTime } from '../../lib/format';

interface BookingItem {
  id: string;
  eventTitle: string;
  seatNumber: string | null;
  quantity: number;
  status: string;
  failReason: string | null;
  createdAt: string;
}

const statusStyles: Record<string, string> = {
  CONFIRMED: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30',
  PENDING: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30',
  FAILED: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30',
  CANCELLED: 'bg-slate-500/15 text-slate-300 ring-1 ring-slate-400/30',
};

export default function MyBookingsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [items, setItems] = useState<BookingItem[] | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    void trpcQuery<{ items: BookingItem[] }>('bookings.myBookings', { limit: 50 }).then((page) =>
      setItems(page.items),
    );
  }, [user]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="mb-6 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-white">
        My bookings
      </h1>
      {items === null ? (
        <p className="text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-slate-400">
          No bookings yet —{' '}
          <Link href="/" className="font-medium text-fuchsia-300 underline underline-offset-4">
            browse events
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((b) => (
            <li key={b.id} className="glass flex items-center justify-between rounded-2xl p-4">
              <div>
                <p className="font-semibold text-white">{b.eventTitle}</p>
                <p className="text-sm text-slate-400">
                  {b.seatNumber ? `Seat ${b.seatNumber}` : `${b.quantity} ticket${b.quantity > 1 ? 's' : ''}`}
                  {' · '}
                  {formatDateTime(b.createdAt)}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles[b.status] ?? ''}`}
              >
                {b.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
