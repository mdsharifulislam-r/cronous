import { Module } from '@nestjs/common';
import { QueuesController, SubmissionsController } from './queues.controller';
import { QueuesService } from './queues.service';
import { SubmissionsService } from './submissions.service';

@Module({
  controllers: [QueuesController, SubmissionsController],
  providers: [QueuesService, SubmissionsService],
  exports: [QueuesService, SubmissionsService],
})
export class QueuesModule {}
