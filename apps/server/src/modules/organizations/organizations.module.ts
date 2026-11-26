import { Module } from '@nestjs/common';
import { MembersService } from './members.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService, MembersService],
})
export class OrganizationsModule {}
