import { Injectable } from '@nestjs/common';
import { Event, Seat } from '@prisma/client';
import { EventQueryInput } from '@seatsure/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../redis/cache.service';

const CACHE_TTL_SECONDS = 60;
export const EVENTS_LIST_PREFIX = 'events:list:';
export const eventCacheKey = (id: string): string => `event:${id}`;

// Dates go out as ISO strings so the DB path and the JSON-cache path return
// the identical shape (tRPC has no transformer configured).
export interface EventDto {
  id: string;
  title: string;
  description: string | null;
  venue: string | null;
  eventTime: string;
  onSaleAt: string;
  status: Event['status'];
  seatingType: Event['seatingType'];
  totalCapacity: number | null;
  remainingCapacity: number | null;
  gaPriceCents: number | null;
  maxSeatsPerOrder: number | null; // ASSIGNED only; null = unrestricted
  organizerId: string;
  createdAt: string;
}

export interface SeatDto {
  id: string;
  seatNumber: string;
  priceCents: number;
  status: Seat['status'];
}

export interface EventListPage {
  items: EventDto[];
  nextCursor: string | null;
}

export const toEventDto = (e: Event): EventDto => ({
  id: e.id,
  title: e.title,
  description: e.description,
  venue: e.venue,
  eventTime: e.eventTime.toISOString(),
  onSaleAt: e.onSaleAt.toISOString(),
  status: e.status,
  seatingType: e.seatingType,
  totalCapacity: e.totalCapacity,
  remainingCapacity: e.remainingCapacity,
  gaPriceCents: e.gaPriceCents,
  maxSeatsPerOrder: e.maxSeatsPerOrder,
  organizerId: e.organizerId,
  createdAt: e.createdAt.toISOString(),
});

/** "A12" → ["A", 12] so seat maps sort A1, A2, … A10 (not lexicographically). */
const seatSortKey = (seatNumber: string): [string, number] => {
  const match = /^([A-Z]+)(\d+)$/.exec(seatNumber);
  return match ? [match[1] ?? '', Number(match[2] ?? 0)] : [seatNumber, 0];
};

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async list(query: EventQueryInput): Promise<EventListPage> {
    const cacheKey = `${EVENTS_LIST_PREFIX}${query.limit}:${query.cursor ?? 'start'}`;
    const cached = await this.cache.getJSON<EventListPage>(cacheKey);
    if (cached) return cached;

    const rows = await this.prisma.event.findMany({
      take: query.limit + 1, // one extra row = "there is a next page"
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const items = rows.slice(0, query.limit).map(toEventDto);
    const page: EventListPage = {
      items,
      nextCursor: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    };
    await this.cache.setJSON(cacheKey, page, CACHE_TTL_SECONDS);
    return page;
  }

  async byId(id: string): Promise<EventDto | null> {
    const cacheKey = eventCacheKey(id);
    const cached = await this.cache.getJSON<EventDto>(cacheKey);
    if (cached) return cached;

    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event) return null;

    const dto = toEventDto(event);
    await this.cache.setJSON(cacheKey, dto, CACHE_TTL_SECONDS);
    return dto;
  }

  /** NEVER cached (ARCHITECTURE.md §5) — stale availability is dangerous. */
  async seatMap(eventId: string): Promise<SeatDto[]> {
    const seats = await this.prisma.seat.findMany({
      where: { eventId },
      select: { id: true, seatNumber: true, priceCents: true, status: true },
    });
    return seats.sort((a, b) => {
      const [rowA, numA] = seatSortKey(a.seatNumber);
      const [rowB, numB] = seatSortKey(b.seatNumber);
      return rowA === rowB ? numA - numB : rowA.localeCompare(rowB);
    });
  }

  /** Called on any event create/update (and later on the on-sale flip). */
  async bustCaches(eventId?: string): Promise<void> {
    await this.cache.bustPrefix(EVENTS_LIST_PREFIX);
    if (eventId) await this.cache.del(eventCacheKey(eventId));
  }
}
