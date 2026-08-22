import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { AnalyticsService } from './analytics.service';
import { BatchesModule } from '../batches/batches.module';
import { CampusesModule } from '../campuses/campuses.module';
import { CampusesService } from '../campuses/campuses.service';

@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly campuses: CampusesService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Trends, difficulty and topic breakdowns, squad comparison' })
  @ApiQuery({ name: 'from', required: false, example: '2026-07-06' })
  @ApiQuery({ name: 'to', required: false, example: '2026-08-04' })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code (A/B) or alias' })
  async overview(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.campuses.resolveScope({ campus, batch });
    return this.analytics.overview(from, to, scope);
  }

  @Get('heatmap')
  @ApiOperation({ summary: 'Programme-wide completion heatmap' })
  @ApiQuery({ name: 'days', required: false })
  @ApiQuery({ name: 'campus', required: false })
  @ApiQuery({ name: 'batch', required: false })
  async heatmap(
    @Query('days') days?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const parsed = days ? Number.parseInt(days, 10) : 120;
    const scope = await this.campuses.resolveScope({ campus, batch });
    return this.analytics.heatmap(
      Number.isFinite(parsed) ? Math.min(parsed, 366) : 120,
      scope,
    );
  }
}

@Module({
  imports: [BatchesModule, CampusesModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
