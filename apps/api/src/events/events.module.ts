import { Module } from '@nestjs/common';
import { EventsQueueModule } from '../queue/events-queue.module';
import { EventsAdminService } from './events-admin.service';
import { EventsService } from './events.service';
import { OnSaleWorker } from './on-sale.worker';

@Module({
  imports: [EventsQueueModule],
  providers: [EventsService, EventsAdminService, OnSaleWorker],
  exports: [EventsService, EventsAdminService],
})
export class EventsModule {}
