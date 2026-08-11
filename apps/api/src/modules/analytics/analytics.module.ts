import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AnalyticsService } from './analytics.service';
import { BatchesModule } from '../batches/batches.module';
import { BatchesService } from '../batches/batches.service';

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly batches: BatchesService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Trends, difficulty and topic breakdowns, squad comparison' })
  @ApiQuery({ name: 'from', required: false, example: '2026-07-06' })
  @ApiQuery({ name: 'to', required: false, example: '2026-08-04' })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code (A/B) or alias' })
  async overview(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('batch') batch?: string,
  ) {
    return this.analytics.overview(from, to, await this.batches.resolveSelector(batch));
  }

  @Get('heatmap')
  @ApiOperation({ summary: 'Programme-wide completion heatmap' })
  @ApiQuery({ name: 'days', required: false })
  @ApiQuery({ name: 'batch', required: false })
  async heatmap(@Query('days') days?: string, @Query('batch') batch?: string) {
    const parsed = days ? Number.parseInt(days, 10) : 120;
    return this.analytics.heatmap(
      Number.isFinite(parsed) ? Math.min(parsed, 366) : 120,
      await this.batches.resolveSelector(batch),
    );
  }
}

@Module({
  imports: [BatchesModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
