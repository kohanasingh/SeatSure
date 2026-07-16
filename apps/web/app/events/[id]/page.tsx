import { TRPCClientError } from '@trpc/client';
import { notFound } from 'next/navigation';
import { QuantityStepper } from '../../../components/quantity-stepper';
import { SeatGrid } from '../../../components/seat-grid';
import { formatDateTime } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';

export const dynamic = 'force-dynamic'; // seat availability must never be statically cached

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

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{event.title}</h1>
        {event.venue && <p className="mt-1 text-gray-600">{event.venue}</p>}
        <p className="mt-1 text-sm text-gray-600">{formatDateTime(event.eventTime)}</p>
        {event.description && <p className="mt-3 text-gray-700">{event.description}</p>}
      </div>

      {event.status !== 'ON_SALE' ? (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
          {event.status === 'DRAFT'
            ? `Tickets go on sale ${formatDateTime(event.onSaleAt)}.`
            : `This event is ${event.status.replace('_', ' ').toLowerCase()}.`}
        </div>
      ) : null}

      {seats ? (
        <SeatGrid seats={seats} />
      ) : (
        <QuantityStepper
          priceCents={event.gaPriceCents ?? 0}
          remaining={event.remainingCapacity ?? 0}
        />
      )}
    </main>
  );
}
