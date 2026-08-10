import { Module } from '@nestjs/common';

import { DashboardModule } from '../dashboard/dashboard.module';
import { ReportsModule } from '../reports/reports.module';
import { DailyReportService } from './daily-report.service';
import { EmailReportsService } from './email-reports.service';
import { BlockersService } from './blockers.service';
import { EmailReportsController } from './email-reports.controller';

@Module({
  imports: [DashboardModule, ReportsModule],
  controllers: [EmailReportsController],
  providers: [DailyReportService, EmailReportsService, BlockersService],
  exports: [DailyReportService, EmailReportsService, BlockersService],
})
export class EmailReportsModule {}
