import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Headline statistics for a program day' })
  @ApiQuery({ name: 'dayKey', required: false, example: '2026-08-04' })
  stats(@Query('dayKey') dayKey?: string) {
    return this.dashboard.getStats(dayKey);
  }

  @Get('mentor/dashboard')
  @ApiOperation({ summary: 'The five "solved N" tables, each with missing questions and reasons' })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'squadId', required: false })
  mentor(@Query('dayKey') dayKey?: string, @Query('squadId') squadId?: string) {
    return this.dashboard.getMentorDashboard(dayKey, squadId);
  }
}
