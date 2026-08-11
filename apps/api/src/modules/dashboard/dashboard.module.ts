import { Module } from '@nestjs/common';
import { AssignmentsModule } from '../assignments/assignments.module';
import { BatchesModule } from '../batches/batches.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AssignmentsModule, BatchesModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
