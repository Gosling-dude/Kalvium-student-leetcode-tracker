import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ATTEMPT_VIEWS, type AttemptView } from '@dsa/shared';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { CampusAttemptsService, type AttemptsFilters } from './campus-attempts.service';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;

function parseFilters(query: Record<string, string | undefined>): AttemptsFilters {
  for (const key of ['from', 'to'] as const) {
    if (query[key] && !DAY_KEY.test(query[key]!)) throw new BadRequestException(`${key} must be YYYY-MM-DD.`);
  }
  const view = query.view || null;
  if (view && !ATTEMPT_VIEWS.includes(view as AttemptView)) {
    throw new BadRequestException(`view must be one of ${ATTEMPT_VIEWS.join(', ')}.`);
  }
  const difficulty = query.difficulty || null;
  if (difficulty && !DIFFICULTIES.includes(difficulty as never)) {
    throw new BadRequestException(`difficulty must be one of ${DIFFICULTIES.join(', ')}.`);
  }
  const minAttempts = query.minAttempts ? Number.parseInt(query.minAttempts, 10) : null;
  if (minAttempts !== null && (!Number.isFinite(minAttempts) || minAttempts < 1)) {
    throw new BadRequestException('minAttempts must be a positive integer.');
  }
  return {
    campusId: query.campus || null,
    batch: query.batch || null,
    squad: query.squad || null,
    from: query.from || null,
    to: query.to || null,
    problem: query.problem || null,
    difficulty: difficulty as AttemptsFilters['difficulty'],
    view: view as AttemptView | null,
    minAttempts,
    search: query.search || null,
  };
}

@ApiTags('Campus analysis')
@ApiBearerAuth()
@Controller('campus-analysis/attempts')
export class CampusAttemptsController {
  constructor(private readonly attempts: CampusAttemptsService) {}

  @Get()
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({
    summary: 'Assigned Coding-Hours problems attempted during their assignment period, with outcomes',
    description:
      'One row per student x assigned problem x assignment day, from the mirrored submissions (no live ' +
      'LeetCode call). Attempts count submissions on the assignment day itself; failed attempts stop at ' +
      'the first accepted. Default view is Attempted But Not Solved.',
  })
  analysis(@CurrentUser() user: RequestUser, @Query() query: Record<string, string | undefined>) {
    return this.attempts.analysis(user, parseFilters(query));
  }

  @Get('export')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'The current view as .xlsx; mode=unsolved exports Attempted But Not Solved only' })
  async export(
    @CurrentUser() user: RequestUser,
    @Query() query: Record<string, string | undefined>,
    @Res() res: Response,
  ): Promise<void> {
    const mode = query.mode === 'unsolved' ? 'unsolved' : 'view';
    const buffer = await this.attempts.buildWorkbook(user, parseFilters(query), mode);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${mode === 'unsolved' ? 'unsolved-attempts' : 'attempts-analysis'}.xlsx"`,
    );
    res.send(buffer);
  }

  @Get('students/:id')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: "One student's attempted assigned problems, with the submissions behind each" })
  student(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    const { from, to } = parseFilters(query);
    return this.attempts.student(user, id, { from, to });
  }
}
