import Link from 'next/link';
import { formatDateTime, formatPrice } from '../lib/format';
import { trpc } from '../lib/trpc';

// Redis (60s TTL) is the caching layer — Next must not add a static one on top.
export const dynamic = 'force-dynamic';

const statusStyles: Record<string, string> = {
  ON_SALE: 'bg-green-100 text-green-800',
  DRAFT: 'bg-yellow-100 text-yellow-800',
  SOLD_OUT: 'bg-red-100 text-red-800',
  ENDED: 'bg-gray-200 text-gray-600',
};

export default async function HomePage() {
  const { items } = await trpc.events.list.query({ limit: 20 });

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Events</h1>
      {items.length === 0 ? (
        <p className="text-gray-600">No events yet.</p>
      ) : (
        <ul className="space-y-4">
          {items.map((event) => (
            <li key={event.id}>
              <Link
                href={`/events/${event.id}`}
                className="block rounded-lg border border-gray-200 p-4 transition-colors hover:border-gray-400"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">{event.title}</h2>
                    {event.venue && <p className="text-sm text-gray-600">{event.venue}</p>}
                    <p className="mt-1 text-sm text-gray-600">{formatDateTime(event.eventTime)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusStyles[event.status] ?? ''}`}
                    >
                      {event.status.replace('_', ' ')}
                    </span>
                    {event.seatingType === 'GENERAL' && event.gaPriceCents !== null && (
                      <span className="text-sm font-medium">{formatPrice(event.gaPriceCents)}</span>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
