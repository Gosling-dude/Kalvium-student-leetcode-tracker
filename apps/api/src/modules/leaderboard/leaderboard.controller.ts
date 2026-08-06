import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { LeaderboardService, type Period } from './leaderboard.service';

@ApiTags('Leaderboard')
@ApiBearerAuth()
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @ApiOperation({ summary: 'Student leaderboard for a period' })
  @ApiQuery({ name: 'period', required: false, enum: ['DAILY', 'WEEKLY', 'MONTHLY'] })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'squadId', required: false })
  @ApiQuery({ name: 'batchId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  students(
    @Query('period') period: Period = 'DAILY',
    @Query('dayKey') dayKey?: string,
    @Query('squadId') squadId?: string,
    @Query('batchId') batchId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.leaderboard.getLeaderboard(period, dayKey, {
      squadId,
      batchId,
      limit: limit ? Math.min(Number.parseInt(limit, 10) || 0, 500) : undefined,
    });
  }

  @Get('squads')
  @ApiOperation({ summary: 'Squad leaderboard for a period' })
  @ApiQuery({ name: 'period', required: false, enum: ['DAILY', 'WEEKLY', 'MONTHLY'] })
  @ApiQuery({ name: 'dayKey', required: false })
  squads(@Query('period') period: Period = 'DAILY', @Query('dayKey') dayKey?: string) {
    return this.leaderboard.getSquadLeaderboard(period, dayKey);
  }
}
