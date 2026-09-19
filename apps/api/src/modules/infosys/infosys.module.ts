import { Module } from '@nestjs/common';

import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAssignmentsController } from './infosys-assignments.controller';
import { InfosysAssignmentsService } from './infosys-assignments.service';
import { InfosysAnalyticsController } from './infosys-analytics.controller';
import { InfosysAnalyticsService } from './infosys-analytics.service';

/**
 * No `CampusesModule` import — Infosys is one cohort, not campus-scoped (see
 * `InfosysAnalyticsService`'s header comment), so it has no dependency on
 * `MentorScopeService` or anything else campus-shaped.
 */
@Module({
  controllers: [InfosysAssignmentsController, InfosysAnalyticsController],
  providers: [InfosysRollupService, InfosysAssignmentsService, InfosysAnalyticsService],
  exports: [InfosysRollupService],
})
export class InfosysModule {}
