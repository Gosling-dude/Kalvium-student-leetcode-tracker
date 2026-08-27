import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { SYNC_MODES, type SyncMode } from '@dsa/shared';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { SyncService } from './sync.service';

class StartSyncDto {
  @IsOptional() @IsIn(SYNC_MODES) mode?: SyncMode;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dayKey?: string;
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) studentIds?: string[];
}

/**
 * Reprocess one historical program day.
 *
 * `dayKey` is the *business* date being corrected, never today. Recomputation reads the
 * submission mirror that is already stored, so this fetches nothing from LeetCode and
 * cannot invent, move or overwrite a submission — it only re-derives the results for that
 * one day from data that is already there.
 */
class BackfillDayDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dayKey must be formatted YYYY-MM-DD' })
  dayKey!: string;
}

@ApiTags('Sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly mentorScope: MentorScopeService,
  ) {}

  @Post()
  @Roles('ADMIN', 'MENTOR')
  @Audit('SYNC_STARTED', 'SyncJob')
  @ApiOperation({ summary: 'Start a sync. Returns immediately; poll the job for progress.' })
  start(@Body() dto: StartSyncDto, @CurrentUser() user: RequestUser) {
    return this.sync.start({
      mode: dto.mode ?? 'INCREMENTAL',
      trigger: 'MANUAL',
      dayKey: dto.dayKey,
      studentIds: dto.studentIds,
      userId: user.id,
    });
  }

  /**
   * Recalculate one past day — the supported answer to "the assignment was added late".
   *
   * Deliberately separate from `POST /sync`: a sync talks to LeetCode and refreshes recent
   * history, while this re-derives one stated day from submissions already mirrored. It
   * touches no other date, and it is safe to run repeatedly.
   */
  @Post('backfill')
  @Roles('ADMIN', 'MENTOR')
  @Audit('SYNC_BACKFILL', 'SyncJob')
  @ApiOperation({
    summary: 'Recalculate one historical day from already-synced submissions',
    description:
      'Use after entering an assignment for a past date. Resolves that date\'s assignments, ' +
      'their campus and batch audience, the eligible students, and the submissions inside ' +
      'the assignment lookback window — then rewrites that day\'s results and leaderboards. ' +
      'No other date is altered and nothing is fetched from LeetCode.',
  })
  backfill(@Body() dto: BackfillDayDto) {
    return this.sync.backfillDay(dto.dayKey);
  }

  @Post('retry-failed')
  @Roles('ADMIN', 'MENTOR')
  @Audit('SYNC_RETRY', 'SyncJob')
  @ApiOperation({ summary: 'Retry only the students whose last sync failed retryably' })
  retryFailed(@CurrentUser() user: RequestUser) {
    return this.sync.start({ mode: 'RETRY_FAILED', trigger: 'RETRY', userId: user.id });
  }

  @Get('jobs')
  @ApiOperation({ summary: 'Sync history' })
  listJobs(@Query() query: PaginationQueryDto) {
    return this.sync.listJobs(query.page, query.pageSize);
  }

  @Get('latest')
  @ApiOperation({ summary: 'The most recent sync job' })
  latest() {
    return this.sync.latestJob();
  }

  @Get('queue')
  @ApiOperation({ summary: 'Queue health and depth' })
  queue() {
    return this.sync.queueHealth();
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'A single sync job, including live progress' })
  job(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.findJob(id);
  }

  @Get('jobs/:id/items')
  @ApiOperation({ summary: 'Per-student outcomes for a sync job' })
  async items(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.sync.jobItems(id, await this.mentorScope.allowedCampusIds(user));
  }

  @Post('jobs/:id/cancel')
  @Roles('ADMIN')
  @Audit('SYNC_CANCELLED', 'SyncJob')
  @ApiOperation({ summary: 'Mark a job cancelled' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.cancel(id);
  }
}
