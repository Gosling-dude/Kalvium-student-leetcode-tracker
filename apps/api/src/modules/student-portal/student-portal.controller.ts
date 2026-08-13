import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { StudentPortalService } from './student-portal.service';
import { StudentAssignmentQueryDto, StudentLeaderboardQueryDto } from './dto/student-portal.dto';

/**
 * Every route here is `@Roles('STUDENT')` — reachable by the STUDENT role (and, via
 * `RolesGuard`'s implicit rule, ADMIN — who has no `studentId` and gets a clean 403 from
 * `StudentPortalService.requireStudentId` rather than a route error). MENTOR and VIEWER
 * are not listed: they have their own Mentor View for this data, scoped to every student
 * rather than one.
 *
 * No handler ever takes a `studentId`, `email` or `batchId` from the request — every one
 * resolves identity from `@CurrentUser()`, which `JwtStrategy` re-reads from the database
 * on every request (§18, §19).
 */
@ApiTags('Student Portal')
@ApiBearerAuth()
@Controller('student')
@Roles('STUDENT')
export class StudentPortalController {
  constructor(private readonly portal: StudentPortalService) {}

  @Get('me')
  @ApiOperation({ summary: 'The logged-in student, in the same shape the admin roster uses' })
  me(@CurrentUser() user: RequestUser) {
    return this.portal.me(user);
  }

  @Get('dashboard')
  @ApiOperation({ summary: "Today's assignment, streak, totals and rank in one call" })
  dashboard(@CurrentUser() user: RequestUser) {
    return this.portal.dashboard(user);
  }

  @Get('profile')
  @ApiOperation({ summary: 'Full profile: identity, level, achievements, heatmap, history — no mentor notes' })
  profile(@CurrentUser() user: RequestUser) {
    return this.portal.profile(user);
  }

  @Get('assignments')
  @ApiOperation({ summary: "Assignment history for the student's own batch" })
  assignments(@CurrentUser() user: RequestUser, @Query() query: StudentAssignmentQueryDto) {
    return this.portal.assignmentHistory(user, query);
  }

  @Get('assignments/:id')
  @ApiOperation({ summary: 'One assignment plus this student\'s own per-problem outcome' })
  assignment(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.assignmentDetail(user, id);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: "The student's batch leaderboard (or the combined one), current student highlighted client-side" })
  leaderboard(@CurrentUser() user: RequestUser, @Query() query: StudentLeaderboardQueryDto) {
    return this.portal.myLeaderboard(user, query);
  }
}
