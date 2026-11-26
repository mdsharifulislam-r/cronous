import { Module } from '@nestjs/common';
import { QueuesModule } from '../queues/queues.module';
import { JobsController } from './jobs.controller';
import { ScheduleController } from './schedule.controller';
import { JobsService } from './jobs.service';

@Module({
  imports: [QueuesModule],
  controllers: [JobsController, ScheduleController],
  providers: [JobsService],
})
export class JobsModule {}
