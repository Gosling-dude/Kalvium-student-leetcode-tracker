import { Module } from '@nestjs/common';
import { RollupService } from './rollup.service';
import { ScoringConfigService } from './scoring-config.service';

@Module({
  providers: [RollupService, ScoringConfigService],
  exports: [RollupService, ScoringConfigService],
})
export class ScoringModule {}
