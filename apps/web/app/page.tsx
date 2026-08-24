import { EventBrowser } from '../components/event-browser';
import { trpc } from '../lib/trpc';

// Redis (60s TTL) is the caching layer — Next must not add a static one on top.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const { items } = await trpc.events.list.query({ limit: 20 });

  return (
    <main>
      <section className="relative overflow-hidden px-6 pb-16 pt-20 text-center">
        <p className="mb-4 inline-block rounded-full border border-fuchsia-400/30 bg-fuchsia-500/10 px-4 py-1 text-xs font-medium tracking-wide text-fuchsia-300">
          Zero overselling — proven under 500+ concurrent bookings
        </p>
        <h1 className="mx-auto max-w-3xl font-[family-name:var(--font-display)] text-4xl font-bold leading-tight tracking-tight text-white sm:text-6xl">
          Find the show. <span className="text-fuchsia-400">Pick your seat.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-slate-400">
          Browse live events, watch seats fill up in real time, and check out in seconds — built
          to never oversell, even when everyone clicks &ldquo;book&rdquo; at once.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        {items.length === 0 ? (
          <p className="text-center text-slate-400">No events yet.</p>
        ) : (
          <EventBrowser events={items} />
        )}
      </section>
    </main>
  );
}
