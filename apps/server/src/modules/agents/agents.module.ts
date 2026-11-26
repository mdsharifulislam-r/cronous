import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentGateway } from './agent.gateway';
import { AgentsController } from './agents.controller';

@Module({
  imports: [AuthModule],
  controllers: [AgentsController],
  providers: [AgentGateway],
  exports: [AgentGateway],
})
export class AgentsModule {}
