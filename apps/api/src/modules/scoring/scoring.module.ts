import { Module } from '@nestjs/common';
import { RollupService } from './rollup.service';
import { ScoringConfigService } from './scoring-config.service';
import { StudentMetricsService } from './student-metrics.service';

@Module({
  providers: [RollupService, ScoringConfigService, StudentMetricsService],
  exports: [RollupService, ScoringConfigService, StudentMetricsService],
})
export class ScoringModule {}
