import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { BadRequestException } from '@nestjs/common';
import { BatchesService } from '../batches/batches.service';
import { LeaderboardService, type Period } from './leaderboard.service';

const PERIODS: Period[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

@ApiTags('Leaderboard')
@ApiBearerAuth()
@Controller('leaderboard')
export class LeaderboardController {
  constructor(
    private readonly leaderboard: LeaderboardService,
    private readonly batches: BatchesService,
  ) {}

  /** Rejects an unrecognised period rather than silently ranking the wrong window. */
  private assertPeriod(period: string): Period {
    if (!PERIODS.includes(period as Period)) {
      throw new BadRequestException(`"${period}" is not a period. Expected one of: ${PERIODS.join(', ')}.`);
    }
    return period as Period;
  }

  @Get()
  @ApiOperation({ summary: 'Student leaderboard for a period' })
  @ApiQuery({ name: 'period', required: false, enum: ['DAILY', 'WEEKLY', 'MONTHLY'] })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'squadId', required: false })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code (A/B) or alias' })
  @ApiQuery({ name: 'limit', required: false })
  async students(
    @Query('period') period = 'DAILY',
    @Query('dayKey') dayKey?: string,
    @Query('squadId') squadId?: string,
    @Query('batch') batch?: string,
    @Query('batchId') batchId?: string,
    @Query('limit') limit?: string,
  ) {
    // `batch` (code or alias) is preferred; `batchId` is kept for existing callers.
    const resolved = await this.batches.resolveSelector(batch ?? batchId);
    return this.leaderboard.getLeaderboard(this.assertPeriod(period), dayKey, {
      squadId,
      batchId: resolved ?? undefined,
      limit: limit ? Math.min(Number.parseInt(limit, 10) || 0, 500) : undefined,
    });
  }

  @Get('squads')
  @ApiOperation({ summary: 'Squad leaderboard for a period' })
  @ApiQuery({ name: 'period', required: false, enum: ['DAILY', 'WEEKLY', 'MONTHLY'] })
  @ApiQuery({ name: 'dayKey', required: false })
  squads(@Query('period') period = 'DAILY', @Query('dayKey') dayKey?: string) {
    return this.leaderboard.getSquadLeaderboard(this.assertPeriod(period), dayKey);
  }
}
