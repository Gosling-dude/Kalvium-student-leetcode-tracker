import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { BatchesService } from '../batches/batches.service';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly batches: BatchesService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Headline statistics for a program day, overall or per batch' })
  @ApiQuery({ name: 'dayKey', required: false, example: '2026-08-04' })
  @ApiQuery({ name: 'batch', required: false, example: 'A', description: 'Batch id, code or alias' })
  async stats(@Query('dayKey') dayKey?: string, @Query('batch') batch?: string) {
    return this.dashboard.getStats(dayKey, {
      batchId: await this.batches.resolveSelector(batch),
    });
  }

  @Get('mentor/dashboard')
  @ApiOperation({ summary: 'The daily tracker: "solved N" tables, split by batch' })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'squadId', required: false })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code or alias' })
  async mentor(
    @Query('dayKey') dayKey?: string,
    @Query('squadId') squadId?: string,
    @Query('batch') batch?: string,
  ) {
    return this.dashboard.getMentorDashboard(dayKey, {
      squadId,
      batchId: await this.batches.resolveSelector(batch),
    });
  }
}
