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
  NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit, CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { AssignmentsService } from './assignments.service';
import { CampusesService } from '../campuses/campuses.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
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
    private readonly mentorScope: MentorScopeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Assignment history, optionally narrowed to a campus and/or batch' })
  async findAll(@Query() query: AssignmentQueryDto, @CurrentUser() user: RequestUser) {
    const scope = await this.campuses.resolveScopeFor(user, {
      campus: query.campus,
      batch: query.batch,
    });
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
  async today(@Query() query: AssignmentDayQueryDto, @CurrentUser() user: RequestUser) {
    const scope = await this.campuses.resolveScopeFor(user, {
      campus: query.campus,
      batch: query.batch,
    });
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
  async byDay(
    @Param('dayKey') dayKey: string,
    @Query() query: AssignmentDayQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    const scope = await this.campuses.resolveScopeFor(user, {
      campus: query.campus,
      batch: query.batch,
    });
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
  async create(@Body() dto: CreateAssignmentDto, @CurrentUser() user: RequestUser) {
    // A mentor may set work for their own campus and nowhere else. Note that an omitted
    // campus is not "harmless default" here — it targets the whole programme, which is
    // why `assertCanWriteCampus` refuses it for a mentor rather than pinning like the
    // read paths do.
    const allowed = await this.mentorScope.allowedCampusIds(user);
    if (allowed !== null) {
      const requested = await this.campuses.resolveSelector(dto.campus ?? null);
      this.mentorScope.assertCanWriteCampus(requested, allowed);
    }
    return this.assignments.create(dto, user.id);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MENTOR')
  @Audit('ASSIGNMENT_UPDATED', 'Assignment')
  @ApiOperation({ summary: 'Update an assignment' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssignmentDto,
    @CurrentUser() user: RequestUser,
  ) {
    // Editing by id skips every list filter, so the row's own campus is what has to be
    // checked. A programme-wide assignment is admin-only to edit even though anyone may
    // read it — changing it changes every campus's work.
    await this.assertMayTouch(id, user, { write: true });
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
  async targetHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    await this.assertMayTouch(id, user, { write: false });
    return this.assignments.audienceHistory(id);
  }

  /**
   * Refuse unless this caller may act on the assignment behind `id`.
   *
   * Answered as "not found" for a campus the caller does not hold — the same answer a
   * genuinely missing id gives — so ids cannot be walked to discover what other campuses
   * have been set.
   */
  private async assertMayTouch(
    id: string,
    user: RequestUser,
    options: { write: boolean },
  ): Promise<void> {
    const allowed = await this.mentorScope.allowedCampusIds(user);
    if (allowed === null) return;

    const assignment = await this.assignments.findCampusOf(id);
    if (assignment === undefined) throw new NotFoundException(`Assignment ${id} was not found`);
    this.mentorScope.assertCampusAllowed(assignment, allowed, {
      entity: 'Assignment',
      id,
      write: options.write,
    });
  }
}
