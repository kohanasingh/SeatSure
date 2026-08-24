'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { eventPhoto } from '../lib/images';
import { formatDateTime, formatPrice } from '../lib/format';

export interface BrowserEvent {
  id: string;
  title: string;
  description: string | null;
  venue: string | null;
  eventTime: string;
  status: string;
  seatingType: 'ASSIGNED' | 'GENERAL';
  gaPriceCents: number | null;
  maxSeatsPerOrder: number | null;
}

const statusStyles: Record<string, string> = {
  ON_SALE: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30',
  DRAFT: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30',
  SOLD_OUT: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30',
  ENDED: 'bg-slate-500/15 text-slate-300 ring-1 ring-slate-400/30',
};

export function EventBrowser({ events }: { events: BrowserEvent[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) =>
      [e.title, e.venue, e.description].filter(Boolean).some((f) => f!.toLowerCase().includes(q)),
    );
  }, [events, query]);

  return (
    <div className="space-y-8">
      <div className="mx-auto max-w-xl">
        <div className="glass flex items-center gap-3 rounded-full px-5 py-3 shadow-lg shadow-black/20">
          <svg
            className="h-4 w-4 shrink-0 text-slate-400"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search shows, venues, artists…"
            className="w-full bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-center text-slate-400">No events match “{query}”.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((event) => (
            <Link
              key={event.id}
              href={`/events/${event.id}`}
              className="group glass relative flex flex-col overflow-hidden rounded-2xl transition-transform duration-300 hover:-translate-y-1 hover:shadow-2xl hover:shadow-fuchsia-500/10"
            >
              <div className="relative h-44 w-full overflow-hidden">
                <Image
                  src={eventPhoto(event.id, event.title, event.description)}
                  alt={event.title}
                  fill
                  sizes="(max-width: 768px) 100vw, 33vw"
                  className="object-cover transition-transform duration-500 group-hover:scale-110"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
                <span
                  className={`absolute right-3 top-3 rounded-full px-2.5 py-0.5 text-[11px] font-semibold backdrop-blur-sm ${statusStyles[event.status] ?? ''}`}
                >
                  {event.status.replace('_', ' ')}
                </span>
                <span className="absolute bottom-3 left-3 rounded-full bg-black/50 px-2.5 py-0.5 text-[11px] font-medium text-slate-200 backdrop-blur-sm">
                  {event.seatingType === 'GENERAL' ? 'General admission' : 'Reserved seating'}
                </span>
              </div>

              <div className="flex flex-1 flex-col gap-1.5 p-4">
                <h2 className="font-[family-name:var(--font-display)] text-lg font-bold leading-tight text-white">
                  {event.title}
                </h2>
                {event.venue && <p className="text-sm text-slate-400">{event.venue}</p>}
                <p className="text-sm text-slate-400">{formatDateTime(event.eventTime)}</p>
                <div className="mt-auto flex items-center justify-between pt-3">
                  {event.seatingType === 'GENERAL' && event.gaPriceCents !== null ? (
                    <span className="text-sm font-semibold text-fuchsia-300">
                      from {formatPrice(event.gaPriceCents)}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-500">
                      {event.maxSeatsPerOrder != null
                        ? `up to ${event.maxSeatsPerOrder}/order`
                        : 'no order limit'}
                    </span>
                  )}
                  <span className="text-sm font-medium text-slate-300 opacity-0 transition-opacity group-hover:opacity-100">
                    View details →
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
