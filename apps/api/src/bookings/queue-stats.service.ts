import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { BOOKINGS_QUEUE, BookingsJobData } from '../queue/bookings-queue.module';

export interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  avgMs: number | null;
}

@Injectable()
export class QueueStatsService {
  constructor(@Inject(BOOKINGS_QUEUE) private readonly queue: Queue<BookingsJobData>) {}

  async stats(): Promise<QueueStats> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'completed', 'failed');
    const recentCompleted = await this.queue.getJobs(['completed'], 0, 49);
    const durations = recentCompleted
      .filter((j) => j.finishedOn && j.processedOn)
      .map((j) => j.finishedOn! - j.processedOn!);

    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      avgMs: durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null,
    };
  }
}
