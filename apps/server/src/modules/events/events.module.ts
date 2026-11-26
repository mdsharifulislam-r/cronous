import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardEventsService } from './dashboard-events.service';
import { EventsController } from './events.controller';

@Module({
  imports: [AuthModule],
  controllers: [EventsController],
  providers: [DashboardEventsService],
  exports: [DashboardEventsService],
})
export class EventsModule {}
