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
import { CampusesService } from '../campuses/campuses.service';
import {
  MentorScopeService,
  type CampusScope,
} from '../campuses/mentor-scope.service';
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
  constructor(
    private readonly baseline: BaselineTestsService,
    private readonly mentorScope: MentorScopeService,
    private readonly campuses: CampusesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Baseline tests, newest first, optionally filtered by campus/batch' })
  async findAll(@Query() query: BaselineTestQueryDto, @CurrentUser() user: RequestUser) {
    return this.baseline.findAll(query, await this.mentorScope.allowedCampusIds(user));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One baseline test' })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    await this.assertMayTouch(id, user, { write: false });
    return this.baseline.findById(id);
  }

  @Get(':id/report')
  @ApiOperation({
    summary: 'Participation, scores, per-problem success, campus/batch breakdown, review queue',
  })
  async report(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    const allowed = await this.assertMayTouch(id, user, { write: false });
    return this.baseline.report(id, allowed);
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
  async leaderboard(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BaselineLeaderboardQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    const allowed = await this.assertMayTouch(id, user, { write: false });
    return this.baseline.leaderboard(id, query, allowed);
  }

  @Get(':id/students/:studentId')
  @ApiOperation({
    summary: "One student's baseline result, with the per-question breakdown",
  })
  async studentResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const allowed = await this.assertMayTouch(id, user, { write: false });
    return this.baseline.studentResult(id, studentId, allowed);
  }

  @Get(':id/attempts')
  @ApiOperation({ summary: 'Every attempt on a test, with risk signals and their evidence' })
  async attempts(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    const allowed = await this.assertMayTouch(id, user, { write: false });
    return this.baseline.attempts(id, allowed);
  }

  @Post()
  @Audit('BASELINE_TEST_CREATED', 'BaselineTest')
  @ApiOperation({ summary: 'Create a baseline test' })
  async create(@Body() dto: CreateBaselineTestDto, @CurrentUser() user: RequestUser) {
    // Like assignments: an omitted campus targets the whole programme, so it is refused
    // for a mentor rather than quietly pinned.
    const allowed = await this.mentorScope.allowedCampusIds(user);
    if (allowed !== null) {
      // `campus` is a selector (code or id), so it is resolved before being compared
      // against the grants, which hold ids.
      const requested = await this.campuses.resolveSelector(dto.campus ?? null);
      this.mentorScope.assertCanWriteCampus(requested, allowed);
    }
    return this.baseline.create(dto, user.id);
  }

  @Patch(':id')
  @Audit('BASELINE_TEST_UPDATED', 'BaselineTest')
  @ApiOperation({ summary: 'Update a baseline test (problems and audience are DRAFT-only)' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBaselineTestDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMayTouch(id, user, { write: true });
    return this.baseline.update(id, dto);
  }

  @Post(':id/duplicate')
  @Audit('BASELINE_TEST_DUPLICATED', 'BaselineTest')
  @ApiOperation({ summary: "Copy a test into a new draft — this week's from last week's" })
  async duplicate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    await this.assertMayTouch(id, user, { write: true });
    return this.baseline.duplicate(id, user.id);
  }

  @Post(':id/publish')
  @Audit('BASELINE_TEST_PUBLISHED', 'BaselineTest')
  @ApiOperation({ summary: 'Make a test visible to its audience and open for attempts' })
  async publish(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    await this.assertMayTouch(id, user, { write: true });
    return this.baseline.setStatus(id, 'ACTIVE');
  }

  @Post(':id/close')
  @Audit('BASELINE_TEST_CLOSED', 'BaselineTest')
  @ApiOperation({ summary: 'Close a test, grade every attempt one final time, freeze the report' })
  async close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    await this.assertMayTouch(id, user, { write: true });
    return this.baseline.setStatus(id, 'CLOSED');
  }

  @Patch(':id/status')
  @Audit('BASELINE_TEST_STATUS_CHANGED', 'BaselineTest')
  @ApiOperation({ summary: 'Move a test through DRAFT → SCHEDULED → ACTIVE → CLOSED' })
  async setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetBaselineStatusDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertMayTouch(id, user, { write: true });
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
  async grade(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    await this.assertMayTouch(id, user, { write: true });
    return this.baseline.gradeTest(id);
  }

  @Patch('attempts/:attemptId/review')
  @Audit('BASELINE_ATTEMPT_REVIEWED', 'BaselineTestAttempt')
  @ApiOperation({ summary: "Record a mentor's conclusion on a flagged attempt" })
  async review(
    @Param('attemptId', ParseUUIDPipe) attemptId: string,
    @Body() dto: ReviewAttemptDto,
    @CurrentUser() user: RequestUser,
  ) {
    // Reviewing is keyed by *attempt*, not by test, so the test-level guard does not
    // reach it — the attempt's own campus is what has to be checked.
    const allowed = await this.mentorScope.allowedCampusIds(user);
    if (allowed !== null) {
      const campusId = await this.baseline.findAttemptCampus(attemptId);
      if (campusId === undefined) {
        throw new NotFoundException(`Attempt ${attemptId} was not found`);
      }
      this.mentorScope.assertCampusAllowed(campusId, allowed, {
        entity: 'Attempt',
        id: attemptId,
        write: true,
      });
    }
    return this.baseline.review(attemptId, dto, { id: user.id, name: user.name });
  }

  /**
   * Refuse unless this caller may act on the baseline test behind `id`, and return the
   * campus scope its rows must then be narrowed to.
   *
   * Two separate jobs, because a baseline test needs both. The *test* may be visible —
   * a programme-wide one applies to every campus, including the caller's — while its
   * *students* must still be narrowed to the caller's campuses. Hiding the test would be
   * wrong (their students really did sit it); returning every campus's results would be
   * the leak. So this authorises the test and hands back the scope for the rows.
   *
   * A test belonging to a campus the caller does not hold is answered as "not found",
   * matching a genuinely missing id, so ids cannot be walked.
   */
  private async assertMayTouch(
    id: string,
    user: RequestUser,
    options: { write: boolean },
  ): Promise<CampusScope> {
    const allowed = await this.mentorScope.allowedCampusIds(user);
    if (allowed === null) return null;

    const campusId = await this.baseline.findCampusOf(id);
    if (campusId === undefined) throw new NotFoundException(`Baseline test ${id} was not found`);
    this.mentorScope.assertCampusAllowed(campusId, allowed, {
      entity: 'Baseline test',
      id,
      write: options.write,
    });
    return allowed;
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
