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
import { BaselineTestsService } from './baseline-tests.service';
import {
  BaselineLeaderboardQueryDto,
  BaselineTestQueryDto,
  CreateBaselineTestDto,
  ReviewAttemptDto,
  SetBaselineStatusDto,
  UpdateBaselineTestDto,
} from './dto/baseline-test.dto';

/**
 * Admin/mentor routes for baseline tests.
 *
 * `@Roles('ADMIN', 'MENTOR')` on the class rather than per method: every route here
 * exposes something students must not see — other students' results, risk signals, admin
 * notes — so the safe default is that a route added later is closed until someone opens
 * it. The student-facing surface is a separate controller with a separate, narrower
 * projection (§22, §35).
 */
@ApiTags('Baseline Tests')
@ApiBearerAuth()
@Controller('baseline-tests')
@Roles('ADMIN', 'MENTOR')
export class BaselineTestsController {
  constructor(private readonly baseline: BaselineTestsService) {}

  @Get()
  @ApiOperation({ summary: 'Baseline tests, newest first, optionally filtered by campus/batch' })
  findAll(@Query() query: BaselineTestQueryDto) {
    return this.baseline.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One baseline test' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.baseline.findById(id);
  }

  @Get(':id/report')
  @ApiOperation({
    summary: 'Participation, scores, per-problem success, campus/batch breakdown, review queue',
  })
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.baseline.report(id);
  }

  @Get(':id/leaderboard')
  @ApiOperation({
    summary: 'Student-wise leaderboard for one baseline test',
    description:
      'Every eligible student, ranked competition-style, including those who never ' +
      'started — "absent" is a result, and a board built only from attempts silently ' +
      'shrinks the denominator. Search, squad and status narrow who is listed; none of ' +
      'them renumber `rank`, which always means "how many students did better".',
  })
  leaderboard(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BaselineLeaderboardQueryDto,
  ) {
    return this.baseline.leaderboard(id, query);
  }

  @Get(':id/students/:studentId')
  @ApiOperation({
    summary: "One student's baseline result, with the per-question breakdown",
  })
  studentResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
  ) {
    return this.baseline.studentResult(id, studentId);
  }

  @Get(':id/attempts')
  @ApiOperation({ summary: 'Every attempt on a test, with risk signals and their evidence' })
  attempts(@Param('id', ParseUUIDPipe) id: string) {
    return this.baseline.attempts(id);
  }

  @Post()
  @Audit('BASELINE_TEST_CREATED', 'BaselineTest')
  @ApiOperation({ summary: 'Create a baseline test' })
  create(@Body() dto: CreateBaselineTestDto, @CurrentUser() user: RequestUser) {
    return this.baseline.create(dto, user.id);
  }

  @Patch(':id')
  @Audit('BASELINE_TEST_UPDATED', 'BaselineTest')
  @ApiOperation({ summary: 'Update a baseline test (problems and audience are DRAFT-only)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBaselineTestDto) {
    return this.baseline.update(id, dto);
  }

  @Post(':id/duplicate')
  @Audit('BASELINE_TEST_DUPLICATED', 'BaselineTest')
  @ApiOperation({ summary: "Copy a test into a new draft — this week's from last week's" })
  duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.baseline.duplicate(id, user.id);
  }

  @Post(':id/publish')
  @Audit('BASELINE_TEST_PUBLISHED', 'BaselineTest')
  @ApiOperation({ summary: 'Make a test visible to its audience and open for attempts' })
  publish(@Param('id', ParseUUIDPipe) id: string) {
    return this.baseline.setStatus(id, 'ACTIVE');
  }

  @Post(':id/close')
  @Audit('BASELINE_TEST_CLOSED', 'BaselineTest')
  @ApiOperation({ summary: 'Close a test, grade every attempt one final time, freeze the report' })
  close(@Param('id', ParseUUIDPipe) id: string) {
    return this.baseline.setStatus(id, 'CLOSED');
  }

  @Patch(':id/status')
  @Audit('BASELINE_TEST_STATUS_CHANGED', 'BaselineTest')
  @ApiOperation({ summary: 'Move a test through DRAFT → SCHEDULED → ACTIVE → CLOSED' })
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetBaselineStatusDto) {
    return this.baseline.setStatus(id, dto.status);
  }

  /**
   * Re-grade from the submission mirror.
   *
   * Needed because grading reads submissions the LeetCode sync has already mirrored: a
   * student who solved a problem minutes before the sync ran is graded correctly only
   * once that sync lands. Re-grading is idempotent and safe on a closed test.
   */
  @Post(':id/grade')
  @Audit('BASELINE_TEST_GRADED', 'BaselineTest')
  @ApiOperation({ summary: 'Re-grade every attempt from the submission mirror' })
  grade(@Param('id', ParseUUIDPipe) id: string) {
    return this.baseline.gradeTest(id);
  }

  @Patch('attempts/:attemptId/review')
  @Audit('BASELINE_ATTEMPT_REVIEWED', 'BaselineTestAttempt')
  @ApiOperation({ summary: "Record a mentor's conclusion on a flagged attempt" })
  review(
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: ReviewAttemptDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.baseline.review(attemptId, dto, { id: user.id, name: user.name });
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('BASELINE_TEST_DELETED', 'BaselineTest')
  @ApiOperation({ summary: 'Delete a test that nobody has attempted' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.baseline.remove(id);
  }
}

/**
 * The student-facing surface, deliberately tiny.
 *
 * Three routes, all keyed off the authenticated session: list mine, start mine, submit
 * mine. There is no route that takes a campus, a batch or another student's id, which is
 * what makes "a student cannot see another campus's test" a property of the API's shape
 * rather than of a check somebody remembered to write (§22, §40).
 */
@ApiTags('Student Portal')
@ApiBearerAuth()
@Controller('student/baseline-tests')
@Roles('STUDENT')
export class StudentBaselineTestsController {
  constructor(private readonly baseline: BaselineTestsService) {}

  private requireStudentId(user: RequestUser): string {
    if (!user.studentId) {
      throw new Error('This account is not linked to a student record.');
    }
    return user.studentId;
  }

  @Get()
  @ApiOperation({ summary: 'Baseline tests targeting my campus and batch' })
  list(@CurrentUser() user: RequestUser) {
    return this.baseline.listForStudent(this.requireStudentId(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my baseline tests' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.baseline.getForStudent(this.requireStudentId(user), id);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start — or resume — my attempt' })
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.baseline.startAttempt(this.requireStudentId(user), id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hand in my attempt' })
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.baseline.submitAttempt(this.requireStudentId(user), id);
  }
}
