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
  CONFIRMED: 'bg-green-100 text-green-800',
  PENDING: 'bg-yellow-100 text-yellow-800',
  FAILED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-gray-200 text-gray-600',
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
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">My bookings</h1>
      {items === null ? (
        <p className="text-gray-600">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-gray-600">
          No bookings yet —{' '}
          <Link href="/" className="font-medium underline">
            browse events
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((b) => (
            <li
              key={b.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 p-4"
            >
              <div>
                <p className="font-semibold">{b.eventTitle}</p>
                <p className="text-sm text-gray-600">
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
