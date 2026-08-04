import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import { SYNC_MODES, type SyncMode } from '@dsa/shared';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { SyncService } from './sync.service';

class StartSyncDto {
  @IsOptional() @IsIn(SYNC_MODES) mode?: SyncMode;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dayKey?: string;
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) studentIds?: string[];
}

@ApiTags('Sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

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
  items(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.jobItems(id);
  }

  @Post('jobs/:id/cancel')
  @Roles('ADMIN')
  @Audit('SYNC_CANCELLED', 'SyncJob')
  @ApiOperation({ summary: 'Mark a job cancelled' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.sync.cancel(id);
  }
}
