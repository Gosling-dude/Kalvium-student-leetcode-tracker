import { Module } from '@nestjs/common';
import { BatchesModule } from '../batches/batches.module';
import { CampusesModule } from '../campuses/campuses.module';
import { RollupService } from './rollup.service';
import { ScoringConfigService } from './scoring-config.service';
import { StudentMetricsService } from './student-metrics.service';

@Module({
  imports: [BatchesModule, CampusesModule],
  providers: [RollupService, ScoringConfigService, StudentMetricsService],
  exports: [RollupService, ScoringConfigService, StudentMetricsService],
})
export class ScoringModule {}
