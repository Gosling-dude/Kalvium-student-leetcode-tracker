import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AnalyticsService } from './analytics.service';

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Trends, difficulty and topic breakdowns, squad comparison' })
  @ApiQuery({ name: 'from', required: false, example: '2026-07-06' })
  @ApiQuery({ name: 'to', required: false, example: '2026-08-04' })
  overview(@Query('from') from?: string, @Query('to') to?: string) {
    return this.analytics.overview(from, to);
  }

  @Get('heatmap')
  @ApiOperation({ summary: 'Programme-wide completion heatmap' })
  @ApiQuery({ name: 'days', required: false })
  heatmap(@Query('days') days?: string) {
    const parsed = days ? Number.parseInt(days, 10) : 120;
    return this.analytics.heatmap(Number.isFinite(parsed) ? Math.min(parsed, 366) : 120);
  }
}

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
