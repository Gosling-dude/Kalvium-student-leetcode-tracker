import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DayKey } from '@dsa/shared';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { InfosysAssignmentsService } from './infosys-assignments.service';
import { InfosysRollupService } from './infosys-rollup.service';
import { CreateInfosysAssignmentDto, UpdateInfosysAssignmentDto } from './dto/infosys-assignment.dto';

@ApiTags('Infosys assignments')
@ApiBearerAuth()
@Controller('infosys/assignments')
export class InfosysAssignmentsController {
  constructor(
    private readonly assignments: InfosysAssignmentsService,
    private readonly rollup: InfosysRollupService,
  ) {}

  @Get()
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'Every Infosys assignment, most recent first' })
  list() {
    return this.assignments.list();
  }

  @Get(':dayKey')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  get(@Param('dayKey') dayKey: string) {
    return this.assignments.get(dayKey as DayKey);
  }

  /** Today's, a future, or a historical Infosys assignment (§3, §4) — `dayKey` is the
   * date the questions were actually given, never defaulted to "today". */
  @Post()
  @Roles('ADMIN', 'MENTOR')
  @ApiOperation({
    summary: 'Create an Infosys day’s problem set',
    description: 'dayKey is the date the questions were actually given, not the date this call happens.',
  })
  create(@Body() dto: CreateInfosysAssignmentDto, @CurrentUser() user: RequestUser) {
    return this.assignments.create(dto, user.id);
  }

  @Put(':dayKey')
  @Roles('ADMIN', 'MENTOR')
  @ApiOperation({ summary: 'Edit an Infosys day’s problem set safely (§3)' })
  update(@Param('dayKey') dayKey: string, @Body() dto: UpdateInfosysAssignmentDto) {
    return this.assignments.update(dayKey as DayKey, dto);
  }

  /**
   * Recompute every Infosys day for one student — call this after adding or correcting
   * a LeetCode profile and letting at least one sync run complete (§14). Not wired into
   * the routine cron automatically yet; see the Infosys rollout notes for why (a full
   * sweep on every 3-hourly sync is not the "incremental recomputation" §21 asks for,
   * and this is the safer interim: idempotent, on-demand, and does not touch the
   * existing sync path at all).
   */
  @Post('recompute/:studentId')
  @Roles('ADMIN', 'MENTOR')
  @ApiOperation({ summary: 'Recompute one student’s whole Infosys history (§14)' })
  recomputeStudent(@Param('studentId', ParseUUIDPipe) studentId: string) {
    return this.rollup.recomputeStudent(studentId);
  }

  /** Full sweep — every assigned day, every enrolled student. For the initial backfill
   * after the first assignment is entered, or after a threshold/schema change. */
  @Post('recompute')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Recompute every Infosys day for every enrolled student' })
  recomputeAll() {
    return this.rollup.recomputeAll();
  }
}
