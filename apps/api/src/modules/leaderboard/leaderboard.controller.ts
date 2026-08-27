import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { BadRequestException } from '@nestjs/common';
import { CurrentUser, type RequestUser } from '../../common/decorators';
import { CampusesService } from '../campuses/campuses.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { LeaderboardService, type Period } from './leaderboard.service';

const PERIODS: Period[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

@ApiTags('Leaderboard')
@ApiBearerAuth()
@Controller('leaderboard')
export class LeaderboardController {
  constructor(
    private readonly leaderboard: LeaderboardService,
    private readonly campuses: CampusesService,
    private readonly mentorScope: MentorScopeService,
  ) {}

  /** Rejects an unrecognised period rather than silently ranking the wrong window. */
  private assertPeriod(period: string): Period {
    if (!PERIODS.includes(period as Period)) {
      throw new BadRequestException(`"${period}" is not a period. Expected one of: ${PERIODS.join(', ')}.`);
    }
    return period as Period;
  }

  /**
   * The one endpoint behind all three boards (§14, §26).
   *
   * No `campus` means the **global** board: every active student, ranked together. Adding
   * `campus` narrows to that campus's board, and adding `batch` narrows again. Every row
   * carries `globalRank` whatever the scope, so the UI can always show "#3 at SRM, #11
   * overall" and a student never disappears because a filter was applied.
   */
  @Get()
  @ApiOperation({ summary: 'Student leaderboard — global, campus, or campus + batch' })
  @ApiQuery({ name: 'period', required: false, enum: ['DAILY', 'WEEKLY', 'MONTHLY'] })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'squadId', required: false })
  @ApiQuery({
    name: 'campus',
    required: false,
    description: 'Campus id or code. Omit or "all" for the global leaderboard.',
  })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code (A/B) or alias' })
  @ApiQuery({ name: 'limit', required: false })
  async students(
    @CurrentUser() user: RequestUser,
    @Query('period') period = 'DAILY',
    @Query('dayKey') dayKey?: string,
    @Query('squadId') squadId?: string,
    @Query('campus') campus?: string,
    @Query('campusId') campusId?: string,
    @Query('batch') batch?: string,
    @Query('batchId') batchId?: string,
    @Query('limit') limit?: string,
  ) {
    // `campus`/`batch` (codes or aliases) are preferred; the `*Id` forms are kept for
    // existing callers. Resolved as a pair so `campus=SRM&batch=A` cannot mean Vels'.
    const scope = await this.campuses.resolveScopeFor(user, {
      campus: campus ?? campusId,
      batch: batch ?? batchId,
    });
    return this.leaderboard.getLeaderboard(this.assertPeriod(period), dayKey, {
      squadId,
      campusId: scope.campusId ?? undefined,
      batchId: scope.batchId ?? undefined,
      onlyUnassigned: scope.onlyUnassigned,
      limit: limit ? Math.min(Number.parseInt(limit, 10) || 0, 500) : undefined,
    });
  }

  @Get('squads')
  @ApiOperation({ summary: 'Squad leaderboard for a period' })
  @ApiQuery({ name: 'period', required: false, enum: ['DAILY', 'WEEKLY', 'MONTHLY'] })
  @ApiQuery({ name: 'dayKey', required: false })
  async squads(
    @CurrentUser() user: RequestUser,
    @Query('period') period = 'DAILY',
    @Query('dayKey') dayKey?: string,
  ) {
    return this.leaderboard.getSquadLeaderboard(
      this.assertPeriod(period),
      dayKey,
      await this.mentorScope.allowedCampusIds(user),
    );
  }
}
