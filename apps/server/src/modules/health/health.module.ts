import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SystemController } from './system.controller';

@Module({
  controllers: [HealthController, SystemController],
  providers: [HealthService],
})
export class HealthModule {}
