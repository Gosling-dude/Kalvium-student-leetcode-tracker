import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { AssignmentsService } from './assignments.service';
import { CampusesService } from '../campuses/campuses.service';
import {
  AssignmentDayQueryDto,
  AssignmentQueryDto,
  ChangeAssignmentTargetDto,
  CreateAssignmentDto,
  PreviewProblemDto,
  UpdateAssignmentDto,
} from './dto/assignment.dto';

@ApiTags('Assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(
    private readonly assignments: AssignmentsService,
    private readonly campuses: CampusesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Assignment history, optionally narrowed to a campus and/or batch' })
  async findAll(@Query() query: AssignmentQueryDto) {
    const scope = await this.campuses.resolveScope({ campus: query.campus, batch: query.batch });
    return this.assignments.findAll({
      page: query.page,
      pageSize: query.pageSize,
      from: query.from,
      to: query.to,
      search: query.search,
      scope,
    });
  }

  @Get('today')
  @ApiOperation({ summary: "Today's assignment for one audience, or every audience's" })
  async today(@Query() query: AssignmentDayQueryDto) {
    const scope = await this.campuses.resolveScope({ campus: query.campus, batch: query.batch });
    return scope.batchId
      ? this.assignments.findToday(scope)
      : this.assignments.findAllToday(scope);
  }

  /**
   * Without a `?batch=` this returns *every* matching audience's set for the day, because
   * on a multi-audience day there is no single assignment that is true for everyone —
   * returning one batch's problems as "the day's assignment" is how another batch, or
   * another campus, ends up measured against work it was never given (§9).
   */
  @Get('day/:dayKey')
  @ApiOperation({ summary: "A date's assignment for one audience, or every audience's" })
  async byDay(@Param('dayKey') dayKey: string, @Query() query: AssignmentDayQueryDto) {
    const scope = await this.campuses.resolveScope({ campus: query.campus, batch: query.batch });
    return scope.batchId
      ? this.assignments.findByDay(dayKey, scope)
      : this.assignments.findAllByDay(dayKey, scope);
  }

  @Post('preview')
  @Roles('ADMIN', 'MENTOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Fetch problem metadata for a URL before saving' })
  preview(@Body() dto: PreviewProblemDto) {
    return this.assignments.previewProblem(dto.url);
  }

  @Post()
  @Roles('ADMIN', 'MENTOR')
  @Audit('ASSIGNMENT_CREATED', 'Assignment')
  @ApiOperation({
    summary: "Create a day's problem set for one campus + batch audience, or several",
  })
  create(@Body() dto: CreateAssignmentDto, @CurrentUser() user: RequestUser) {
    return this.assignments.create(dto, user.id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MENTOR')
  @Audit('ASSIGNMENT_UPDATED', 'Assignment')
  @ApiOperation({ summary: 'Update an assignment' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssignmentDto) {
    return this.assignments.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('ASSIGNMENT_DELETED', 'Assignment')
  @ApiOperation({ summary: 'Delete an assignment' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.assignments.remove(id);
  }

  /**
   * "Change Assignment Target" (§9) — admin-only, since it changes who a past or present
   * day's problem set officially belongs to. Never mutates a `DailyStatus`; see the
   * service method's comment for why that is safe.
   */
  @Patch(':id/target')
  @Roles('ADMIN')
  @Audit('ASSIGNMENT_TARGET_CHANGED', 'Assignment')
  @ApiOperation({ summary: 'Retarget an assignment to another campus and/or batch' })
  changeTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeAssignmentTargetDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.assignments.changeTarget(id, dto, { id: user.id, name: user.name });
  }

  @Get(':id/target-history')
  @ApiOperation({ summary: "An assignment's audience retargets over time, newest first" })
  targetHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.audienceHistory(id);
  }
}
