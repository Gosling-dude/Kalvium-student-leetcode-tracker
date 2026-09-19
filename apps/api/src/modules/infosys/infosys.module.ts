import { Module } from '@nestjs/common';

import { CampusesModule } from '../campuses/campuses.module';
import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAssignmentsController } from './infosys-assignments.controller';
import { InfosysAssignmentsService } from './infosys-assignments.service';
import { InfosysAnalyticsController } from './infosys-analytics.controller';
import { InfosysAnalyticsService } from './infosys-analytics.service';

@Module({
  imports: [CampusesModule],
  controllers: [InfosysAssignmentsController, InfosysAnalyticsController],
  providers: [InfosysRollupService, InfosysAssignmentsService, InfosysAnalyticsService],
  exports: [InfosysRollupService],
})
export class InfosysModule {}
