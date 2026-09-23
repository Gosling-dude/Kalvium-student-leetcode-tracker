import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { CampusCategory } from '@dsa/shared';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { CampusDailyReportService } from './campus-daily-report.service';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function parseAsOf(asOf: string | undefined): string {
  if (!asOf) throw new BadRequestException('asOf is required, as YYYY-MM-DD.');
  if (!DAY_KEY.test(asOf)) throw new BadRequestException('asOf must be in YYYY-MM-DD format.');
  return asOf;
}

@ApiTags('Campus analysis')
@ApiBearerAuth()
@Controller('campus-analysis/daily-report')
export class CampusDailyReportController {
  constructor(private readonly report: CampusDailyReportService) {}

  @Get()
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({
    summary: 'The wide, date-wise Coding-Hours submission matrix up to an as-of date',
    description:
      'One row per active student across the campuses this caller may see, one column per day with real ' +
      'DailyStatus data. campus/batch/squad/category/search narrow which rows are returned; the underlying ' +
      'data — and every other Coding-Hours screen reading it — is unchanged.',
  })
  get(
    @CurrentUser() user: RequestUser,
    @Query('asOf') asOf: string | undefined,
    @Query('campus') campus: string | undefined,
    @Query('batch') batch: string | undefined,
    @Query('squad') squad: string | undefined,
    @Query('category') category: string | undefined,
    @Query('search') search: string | undefined,
  ) {
    return this.report.buildReport(user, parseAsOf(asOf), {
      campusId: campus || null,
      batch: batch || null,
      squad: squad || null,
      category: (category as CampusCategory) || null,
      search: search || null,
    });
  }

  @Get('export')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'Download the current report view as an .xlsx workbook' })
  async export(
    @CurrentUser() user: RequestUser,
    @Query('asOf') asOf: string | undefined,
    @Query('campus') campus: string | undefined,
    @Query('batch') batch: string | undefined,
    @Query('squad') squad: string | undefined,
    @Query('category') category: string | undefined,
    @Query('search') search: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const resolvedAsOf = parseAsOf(asOf);
    const buffer = await this.report.buildWorkbook(user, resolvedAsOf, {
      campusId: campus || null,
      batch: batch || null,
      squad: squad || null,
      category: (category as CampusCategory) || null,
      search: search || null,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="campus-analysis-report-${resolvedAsOf}.xlsx"`);
    res.send(buffer);
  }
}
