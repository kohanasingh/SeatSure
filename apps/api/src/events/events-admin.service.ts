import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateEventInput, SeatLayoutInput, UpdateEventInput } from '@seatsure/shared';
import { TRPCError } from '@trpc/server';
import { Queue } from 'bullmq';
import { AuthenticatedUser } from '../auth/types';
import { PrismaService } from '../prisma/prisma.service';
import {
  EVENTS_QUEUE,
  FLIP_ON_SALE_JOB,
  FlipOnSaleJobData,
  flipJobId,
} from '../queue/events-queue.module';
import { EventDto, EventsService, toEventDto } from './events.service';

/** {rows: 2, seatsPerRow: 3} → A1 A2 A3 B1 B2 B3 */
const generateSeats = (layout: SeatLayoutInput): { seatNumber: string; priceCents: number }[] =>
  Array.from({ length: layout.rows }, (_, row) =>
    Array.from({ length: layout.seatsPerRow }, (_, n) => ({
      seatNumber: `${String.fromCharCode(65 + row)}${n + 1}`,
      priceCents: layout.priceCents,
    })),
  ).flat();

@Injectable()
export class EventsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    @Inject(EVENTS_QUEUE) private readonly queue: Queue<FlipOnSaleJobData>,
  ) {}

  async createEvent(input: CreateEventInput, organizerId: string): Promise<EventDto> {
    const base: Prisma.EventCreateInput = {
      title: input.title,
      description: input.description,
      venue: input.venue,
      eventTime: input.eventTime,
      onSaleAt: input.onSaleAt,
      status: 'DRAFT',
      seatingType: input.seatingType,
      organizerId,
    };

    const event = await this.prisma.$transaction(async (tx) => {
      if (input.seatingType === 'GENERAL') {
        return tx.event.create({
          data: {
            ...base,
            totalCapacity: input.totalCapacity,
            remainingCapacity: input.totalCapacity,
            gaPriceCents: input.gaPriceCents,
          },
        });
      }
      const created = await tx.event.create({ data: base });
      await tx.seat.createMany({
        data: generateSeats(input.seatLayout).map((s) => ({ ...s, eventId: created.id })),
      });
      return created;
    });

    await this.scheduleFlip(event.id, event.onSaleAt);
    await this.events.bustCaches(event.id);
    return toEventDto(event);
  }

  async updateEvent(input: UpdateEventInput, user: AuthenticatedUser): Promise<EventDto> {
    const existing = await this.prisma.event.findUnique({ where: { id: input.id } });
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
    if (user.role !== 'ADMIN' && existing.organizerId !== user.id) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your event' });
    }

    const { id, ...fields } = input;
    const event = await this.prisma.event.update({ where: { id }, data: fields });

    // A changed onSaleAt on a still-DRAFT event moves its scheduled flip.
    if (input.onSaleAt && event.status === 'DRAFT') {
      await this.queue.remove(flipJobId(id));
      await this.scheduleFlip(id, event.onSaleAt);
    }
    await this.events.bustCaches(id);
    return toEventDto(event);
  }

  private async scheduleFlip(eventId: string, onSaleAt: Date): Promise<void> {
    await this.queue.add(
      FLIP_ON_SALE_JOB,
      { eventId },
      {
        jobId: flipJobId(eventId), // dedupes: one pending flip per event
        delay: Math.max(0, onSaleAt.getTime() - Date.now()),
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
