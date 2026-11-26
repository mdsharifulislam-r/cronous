import { Global, Module } from '@nestjs/common';
import { QueueFactory } from './queue.factory';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, QueueFactory],
  exports: [RedisService, QueueFactory],
})
export class RedisModule {}
