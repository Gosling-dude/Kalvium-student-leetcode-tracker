/**
 * Campus-wise analysis endpoints.
 *
 * Scoping is enforced in `CampusAnalysisService`, against the same `MentorScopeService`
 * every other campus-aware endpoint uses — not in this controller and emphatically not in
 * the frontend. A mentor calling these directly with another campus's id gets the same
 * answer as a mentor clicking through the UI, because there is only one place the
 * question is asked.
 */

import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CAMPUS_CATEGORIES, type CampusCategory } from '@dsa/shared';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { CampusAnalysisService } from './campus-analysis.service';

@ApiTags('Campus analysis')
@ApiBearerAuth()
@Controller('campus-analysis')
export class CampusAnalysisController {
  constructor(private readonly analysis: CampusAnalysisService) {}

  private assertCategory(value: string): CampusCategory {
    if (!CAMPUS_CATEGORIES.includes(value as CampusCategory)) {
      throw new BadRequestException(
        `"${value}" is not a category. Expected one of: ${CAMPUS_CATEGORIES.join(', ')}.`,
      );
    }
    return value as CampusCategory;
  }

  /**
   * One card per campus the caller may see, each carrying its category counts.
   *
   * Admins get every campus; a mentor gets exactly their grants. There is no "all
   * campuses" parameter that widens that, because there is no caller for whom it would be
   * correct.
   */
  @Get('summary')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({
    summary: 'Campus cards with category counts and weekly totals',
    description:
      'Defaults to the whole programme. Category counts and the drill-down behind them ' +
      'are derived from one call to the same canonical rows, so they cannot disagree.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Program day, YYYY-MM-DD. Defaults to the first assigned day.' })
  @ApiQuery({ name: 'to', required: false, description: 'Program day, YYYY-MM-DD. Defaults to today.' })
  @ApiQuery({ name: 'campusId', required: false, description: 'Narrow to one campus you may see.' })
  summary(
    @CurrentUser() user: RequestUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('campusId') campusId?: string,
  ) {
    return this.analysis.summary(user, { from, to, campusId });
  }

  /** The students behind one category card, with their weekly progression. */
  @Get(':campusId/categories/:category')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({
    summary: 'The students in one category, with the evidence for each verdict',
    description:
      'Every student carries the weekly rows the verdict was computed from and a ' +
      'sentence naming why they landed there, so a mentor can check it rather than trust it.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  drillDown(
    @CurrentUser() user: RequestUser,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Param('category') category: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analysis.drillDown(user, campusId, this.assertCategory(category), { from, to });
  }

  /**
   * Every question set for one campus, with the student counts behind each.
   *
   * The supporting view: the campus card says how many questions, this says how many
   * students got each one. Optional `weekNumber` narrows to one row of that card.
   */
  @Get(':campusId/questions')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({
    summary: 'Question-by-question detail for one campus',
    description:
      'One row per distinct LeetCode problem, never per student-question pair. The ' +
      'student counts beside each question are supporting detail, not the headline.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'weekNumber', required: false, description: 'Narrow to one week of the period.' })
  campusQuestions(
    @CurrentUser() user: RequestUser,
    @Param('campusId', ParseUUIDPipe) campusId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('weekNumber') weekNumber?: string,
  ) {
    const week = weekNumber === undefined ? undefined : Number.parseInt(weekNumber, 10);
    if (week !== undefined && !Number.isFinite(week)) {
      throw new BadRequestException(`"${weekNumber}" is not a week number.`);
    }
    return this.analysis.questions(user, campusId, { from, to, weekNumber: week });
  }

  /**
   * One student, day by day and question by question.
   *
   * Open to students for their own record — the only role that may reach it without a
   * campus grant, and only for themselves.
   */
  @Get('students/:studentId')
  @Roles('ADMIN', 'MENTOR', 'VIEWER', 'STUDENT')
  @ApiOperation({ summary: 'Daily and per-question detail for one student' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  studentDetail(
    @CurrentUser() user: RequestUser,
    @Param('studentId', ParseUUIDPipe) studentId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.analysis.studentDetail(user, studentId, { from, to });
  }
}
