import { TRPCClientError } from '@trpc/client';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { QuantityStepper } from '../../../components/quantity-stepper';
import { SeatGrid } from '../../../components/seat-grid';
import { eventGallery, eventPhoto } from '../../../lib/images';
import { formatDateTime } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';

export const dynamic = 'force-dynamic'; // seat availability must never be statically cached

const statusBanner: Record<string, (onSaleAt: string) => string> = {
  DRAFT: (onSaleAt) => `Tickets go on sale ${formatDateTime(onSaleAt)}.`,
  SOLD_OUT: () => 'This event is sold out.',
  ENDED: () => 'This event has ended.',
};

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let event;
  try {
    event = await trpc.events.byId.query({ id });
  } catch (err) {
    if (err instanceof TRPCClientError && err.data?.code === 'NOT_FOUND') notFound();
    if (err instanceof TRPCClientError && err.data?.code === 'BAD_REQUEST') notFound(); // non-uuid id
    throw err;
  }

  const seats = event.seatingType === 'ASSIGNED' ? await trpc.events.seatMap.query({ eventId: id }) : null;
  const hero = eventPhoto(event.id, event.title, event.description);
  const gallery = eventGallery(event.id, event.title, event.description);

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-6 pb-24 pt-6">
      <div className="relative h-72 w-full overflow-hidden rounded-3xl sm:h-96">
        <Image src={hero} alt={event.title} fill priority sizes="100vw" className="object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-6 sm:p-8">
          <span className="mb-3 inline-block rounded-full bg-black/40 px-3 py-1 text-xs font-medium text-slate-200 backdrop-blur-sm">
            {event.seatingType === 'GENERAL' ? 'General admission' : 'Reserved seating'}
          </span>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight text-white sm:text-5xl">
            {event.title}
          </h1>
          <p className="mt-2 text-slate-200">
            {event.venue ? `${event.venue} · ` : ''}
            {formatDateTime(event.eventTime)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {gallery.map((src, i) => (
          <div key={src} className="relative h-24 overflow-hidden rounded-xl sm:h-32">
            <Image
              src={src}
              alt=""
              fill
              sizes="200px"
              className="object-cover opacity-90 transition-opacity hover:opacity-100"
              priority={i === 0}
            />
          </div>
        ))}
      </div>

           {event.description && (
        <div className="glass rounded-2xl p-5">
          <h2 className="mb-2 font-[family-name:var(--font-display)] text-sm font-bold uppercase tracking-wide text-slate-400">
            About this show
          </h2>
          <p className="leading-relaxed text-slate-200">{event.description}</p>
          <p className="mt-3 text-sm text-slate-400">
            {event.seatingType === 'GENERAL'
              ? 'General admission — no assigned seats, up to 8 tickets per order.'
              : event.maxSeatsPerOrder != null
                ? `Reserved seating — up to ${event.maxSeatsPerOrder} seat${event.maxSeatsPerOrder > 1 ? 's' : ''} per order.`
                : 'Reserved seating — no limit on seats per order.'}
          </p>
        </div>
      )}

      {event.status !== 'ON_SALE' && statusBanner[event.status] ? (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          {statusBanner[event.status]!(event.onSaleAt)}
        </div>
      ) : null}

      {seats ? (
        <SeatGrid eventId={event.id} seats={seats} maxSeatsPerOrder={event.maxSeatsPerOrder} />
      ) : (
        <QuantityStepper
          eventId={event.id}
          priceCents={event.gaPriceCents ?? 0}
          remaining={event.remainingCapacity ?? 0}
        />
      )}
    </main>
  );
}
