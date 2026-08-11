import { Module } from '@nestjs/common';

import { SyncModule } from '../sync/sync.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { EmailReportsModule } from '../email-reports/email-reports.module';
import { BatchesModule } from '../batches/batches.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CronTasksService } from './cron-tasks.service';
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
  ],
  controllers: [InternalController],
  providers: [CronTasksService],
  exports: [CronTasksService],
})
export class InternalModule {}
