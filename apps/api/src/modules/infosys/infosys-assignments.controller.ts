import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DayKey } from '@dsa/shared';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { InfosysAssignmentsService } from './infosys-assignments.service';
import { CreateInfosysAssignmentDto, UpdateInfosysAssignmentDto } from './dto/infosys-assignment.dto';

@ApiTags('Infosys assignments')
@ApiBearerAuth()
@Controller('infosys/assignments')
export class InfosysAssignmentsController {
  constructor(private readonly assignments: InfosysAssignmentsService) {}

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
}
