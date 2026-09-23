import { Module } from '@nestjs/common';

import { InfosysRollupService } from './infosys-rollup.service';
import { InfosysAssignmentsController } from './infosys-assignments.controller';
import { InfosysAssignmentsService } from './infosys-assignments.service';
import { InfosysAnalyticsController } from './infosys-analytics.controller';
import { InfosysAnalyticsService } from './infosys-analytics.service';
import { InfosysStudentsController } from './infosys-students.controller';
import { InfosysStudentsService } from './infosys-students.service';
import { InfosysDailyReportController } from './infosys-daily-report.controller';
import { InfosysDailyReportService } from './infosys-daily-report.service';

/**
 * No `CampusesModule` import — Infosys is one cohort, not campus-scoped (see
 * `InfosysAnalyticsService`'s header comment), so it has no dependency on
 * `MentorScopeService` or anything else campus-shaped. `campusId`/`campusName`
 * still flow through as informational fields and report/filter values — see the
 * "one cohort" note in `infosys-analysis.ts` for why that is not a contradiction.
 */
@Module({
  controllers: [
    InfosysAssignmentsController,
    InfosysAnalyticsController,
    InfosysStudentsController,
    InfosysDailyReportController,
  ],
  providers: [
    InfosysRollupService,
    InfosysAssignmentsService,
    InfosysAnalyticsService,
    InfosysStudentsService,
    InfosysDailyReportService,
  ],
  exports: [InfosysRollupService],
})
export class InfosysModule {}
