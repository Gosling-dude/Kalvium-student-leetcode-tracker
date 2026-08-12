/**
 * Admin operations: batches, squads, scoring formula, recomputation, system health.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsHexColor,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { ScoringConfig } from '@dsa/shared';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { ScoringModule } from '../scoring/scoring.module';
import { BatchesModule } from '../batches/batches.module';
import { BatchesService } from '../batches/batches.service';
import { RollupService } from '../scoring/rollup.service';
import { ScoringConfigService } from '../scoring/scoring-config.service';
import { AuditService } from '../audit/audit.service';

class UpsertBatchDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
}

class UpsertSquadDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsUUID() batchId?: string;
  @IsOptional() @IsUUID() mentorId?: string;
  @IsOptional() @IsHexColor() color?: string;
}

class CreateScoringConfigDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  config!: Partial<ScoringConfig>;
}

class RecomputeDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  /**
   * Bypasses the `batchId`/`assignmentId` freeze on `DailyStatus` — see
   * `RollupService.recomputeDay`. Only for correcting a day whose frozen values were
   * wrong from the start (a fixed upstream data bug), never for routine recomputation.
   */
  @IsOptional() @IsBoolean() force?: boolean;
}

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    private readonly rollup: RollupService,
    private readonly scoringConfig: ScoringConfigService,
    private readonly audit: AuditService,
    private readonly batches: BatchesService,
  ) {}

  // --- Batches -------------------------------------------------------------

  @Get('batches')
  @ApiOperation({ summary: 'List batches' })
  listBatches() {
    return this.prisma.batch.findMany({
      include: { _count: { select: { students: true, squads: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  @Post('batches')
  @Audit('BATCH_CREATED', 'Batch')
  @ApiOperation({ summary: 'Create a batch' })
  async createBatch(@Body() dto: UpsertBatchDto) {
    // `code` is required and unique; derive one so this legacy name-only route keeps
    // working alongside the richer POST /batches.
    return this.prisma.batch.create({
      data: { name: dto.name, code: await this.batches.deriveAvailableCode(dto.name) },
    });
  }

  @Patch('batches/:id')
  @Audit('BATCH_UPDATED', 'Batch')
  @ApiOperation({ summary: 'Rename a batch' })
  updateBatch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertBatchDto) {
    return this.prisma.batch.update({ where: { id }, data: { name: dto.name } });
  }

  @Delete('batches/:id')
  @Audit('BATCH_DELETED', 'Batch')
  @ApiOperation({ summary: 'Delete a batch (students are detached, not deleted)' })
  deleteBatch(@Param('id', ParseUUIDPipe) id: string) {
    return this.prisma.batch.delete({ where: { id } });
  }

  // --- Squads --------------------------------------------------------------

  @Get('squads')
  @ApiOperation({ summary: 'List squads' })
  listSquads() {
    return this.prisma.squad.findMany({
      include: {
        batch: { select: { name: true } },
        mentor: { select: { id: true, name: true } },
        _count: { select: { students: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  @Post('squads')
  @Audit('SQUAD_CREATED', 'Squad')
  @ApiOperation({ summary: 'Create a squad' })
  createSquad(@Body() dto: UpsertSquadDto) {
    return this.prisma.squad.create({
      data: {
        name: dto.name,
        batchId: dto.batchId ?? null,
        mentorId: dto.mentorId ?? null,
        color: dto.color ?? null,
      },
    });
  }

  @Patch('squads/:id')
  @Audit('SQUAD_UPDATED', 'Squad')
  @ApiOperation({ summary: 'Update a squad, including its assigned mentor' })
  updateSquad(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertSquadDto) {
    return this.prisma.squad.update({
      where: { id },
      data: {
        name: dto.name,
        ...(dto.batchId !== undefined ? { batchId: dto.batchId } : {}),
        ...(dto.mentorId !== undefined ? { mentorId: dto.mentorId } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
      },
    });
  }

  @Delete('squads/:id')
  @Audit('SQUAD_DELETED', 'Squad')
  @ApiOperation({ summary: 'Delete a squad' })
  deleteSquad(@Param('id', ParseUUIDPipe) id: string) {
    return this.prisma.squad.delete({ where: { id } });
  }

  // --- Mentors -------------------------------------------------------------

  @Get('mentors')
  @ApiOperation({ summary: 'List mentor accounts' })
  listMentors() {
    return this.prisma.user.findMany({
      where: { role: { in: ['MENTOR', 'ADMIN'] } },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        _count: { select: { mentoredSquads: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  // --- Scoring formula -----------------------------------------------------

  @Get('scoring')
  @ApiOperation({ summary: 'Active scoring formula and its history' })
  async scoring() {
    return {
      active: await this.scoringConfig.getActive(),
      activeVersion: await this.scoringConfig.getActiveVersion(),
      history: await this.scoringConfig.list(),
    };
  }

  @Post('scoring')
  @Audit('SCORING_CONFIG_CREATED', 'ScoringConfig')
  @ApiOperation({ summary: 'Create and activate a new scoring formula' })
  createScoring(@Body() dto: CreateScoringConfigDto, @CurrentUser() user: RequestUser) {
    return this.scoringConfig.create(dto.name, dto.config, user.id, true);
  }

  @Post('scoring/:id/activate')
  @Audit('SCORING_CONFIG_ACTIVATED', 'ScoringConfig')
  @ApiOperation({ summary: 'Activate a previous scoring formula' })
  activateScoring(@Param('id', ParseUUIDPipe) id: string) {
    return this.scoringConfig.activate(id);
  }

  // --- Recomputation -------------------------------------------------------

  @Post('recompute')
  @HttpCode(HttpStatus.ACCEPTED)
  @Audit('SCORES_RECOMPUTED', 'System')
  @ApiOperation({
    summary: 'Rebuild all derived state for a date range from the submission mirror',
    description:
      'Runs in the background and returns immediately. At 250 students over 30 days ' +
      'this is tens of thousands of writes and takes minutes — far longer than an ' +
      'HTTP request should be held open. Watch the system log for completion.',
  })
  recompute(@Body() dto: RecomputeDto) {
    const to = dto.to ?? this.time.today();
    // Default to the last 30 days: recomputing all history on a mis-click would be a
    // long, surprising operation.
    const from = dto.from ?? this.time.addDays(to, -29);

    // Detached deliberately. Awaiting it would exceed any sane request timeout and the
    // client would see a dead connection while the work continued regardless.
    void this.rollup
      .recomputeRange(from, to, { force: dto.force ?? false })
      .then((result) =>
        this.audit.log(
          'INFO',
          'AdminController',
          `Recompute finished for ${from}…${to}${dto.force ? ' (forced)' : ''}`,
          result,
        ),
      )
      .catch((error: Error) =>
        this.audit.log('ERROR', 'AdminController', `Recompute failed: ${error.message}`),
      );

    return { accepted: true, from, to, force: dto.force ?? false, note: 'Running in the background.' };
  }

  @Post('leaderboard/reset')
  @Audit('LEADERBOARD_RESET', 'System')
  @ApiOperation({ summary: 'Clear and rebuild leaderboards for a day' })
  async resetLeaderboard(@Query('dayKey') dayKey?: string) {
    const day = dayKey ?? this.time.today();
    await this.rollup.rebuildLeaderboards(day);
    return { dayKey: day, rebuilt: true };
  }

  @Post('cache/flush')
  @Audit('CACHE_FLUSHED', 'System')
  @ApiOperation({ summary: 'Flush the application cache' })
  async flushCache() {
    await this.cache.flush();
    return { flushed: true };
  }

  // --- Settings ------------------------------------------------------------

  @Get('settings')
  @ApiOperation({ summary: 'Application settings' })
  async settings() {
    const rows = await this.prisma.setting.findMany();
    return {
      programTimezone: this.time.timezone,
      values: Object.fromEntries(rows.map((row) => [row.key, row.value])),
    };
  }

  @Patch('settings/:key')
  @Audit('SETTING_UPDATED', 'Setting')
  @ApiOperation({ summary: 'Update a setting' })
  updateSetting(@Param('key') key: string, @Body() body: { value: unknown }) {
    return this.prisma.setting.upsert({
      where: { key },
      create: { key, value: body.value as never },
      update: { value: body.value as never },
    });
  }
}

@Module({
  imports: [ScoringModule, BatchesModule],
  controllers: [AdminController],
})
export class AdminModule {}
