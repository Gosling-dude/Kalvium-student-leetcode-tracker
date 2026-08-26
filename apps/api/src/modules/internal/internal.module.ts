import { Module } from '@nestjs/common';

import { SyncModule } from '../sync/sync.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { EmailReportsModule } from '../email-reports/email-reports.module';
import { BatchesModule } from '../batches/batches.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BaselineTestsModule } from '../baseline-tests/baseline-tests.module';
import { StudentsModule } from '../students/students.module';
import { CampusesModule } from '../campuses/campuses.module';
import { CronTasksService } from './cron-tasks.service';
import { IntegrityService } from './integrity.service';
import { InternalController } from './internal.controller';

/**
 * Wires the cron workloads to an HTTP surface (for GitHub Actions) and exports the
 * shared `CronTasksService` so the standalone `jobs/cron.ts` entrypoint runs the same
 * code path. Imports the feature modules whose services the tasks orchestrate.
 */
@Module({
  imports: [
    SyncModule,
    ScoringModule,
    AuthModule,
    AuditModule,
    EmailReportsModule,
    NotificationsModule,
    BatchesModule,
    // Read-only: the integrity report checks what the baseline leaderboard actually
    // computes, using the real service rather than a copy of its logic.
    BaselineTestsModule,
    // The roster import reaches production through this module — see the endpoint's note
    // on why a public repository cannot carry the data itself.
    StudentsModule,
    CampusesModule,
  ],
  controllers: [InternalController],
  providers: [CronTasksService, IntegrityService],
  exports: [CronTasksService, IntegrityService],
})
export class InternalModule {}
