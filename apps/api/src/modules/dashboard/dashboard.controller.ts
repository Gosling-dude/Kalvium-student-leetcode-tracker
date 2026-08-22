import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { CampusesService } from '../campuses/campuses.service';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly campuses: CampusesService,
  ) {}

  /**
   * Both filters are resolved as a pair, and both are applied server-side.
   *
   * Returning every campus's numbers for the client to filter would be wrong twice over:
   * it leaks one campus's figures to a mentor scoped to another, and it moves an
   * aggregation over the whole roster into the browser, which is exactly what §12 and §27
   * rule out.
   */
  @Get('dashboard')
  @ApiOperation({
    summary: 'Headline statistics for a program day — global, per campus, or per batch',
  })
  @ApiQuery({ name: 'dayKey', required: false, example: '2026-08-04' })
  @ApiQuery({
    name: 'campus',
    required: false,
    example: 'SRM',
    description: 'Campus id or code. Omit or "all" for every campus.',
  })
  @ApiQuery({ name: 'batch', required: false, example: 'A', description: 'Batch id, code or alias' })
  async stats(
    @Query('dayKey') dayKey?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.campuses.resolveScope({ campus, batch });
    return this.dashboard.getStats(dayKey, {
      campusId: scope.campusId,
      batchId: scope.batchId,
      onlyUnassigned: scope.onlyUnassigned,
    });
  }

  @Get('mentor/dashboard')
  @ApiOperation({
    summary: 'The daily tracker: "solved N" tables, split by campus and batch',
  })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'squadId', required: false })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code or alias' })
  async mentor(
    @Query('dayKey') dayKey?: string,
    @Query('squadId') squadId?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.campuses.resolveScope({ campus, batch });
    return this.dashboard.getMentorDashboard(dayKey, {
      squadId,
      campusId: scope.campusId,
      batchId: scope.batchId,
      onlyUnassigned: scope.onlyUnassigned,
    });
  }
}
