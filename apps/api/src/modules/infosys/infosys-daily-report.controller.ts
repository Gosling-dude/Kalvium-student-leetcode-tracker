import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { InfosysCategory } from '@dsa/shared';

import { Roles } from '../../common/decorators';
import { InfosysDailyReportService } from './infosys-daily-report.service';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function parseAsOf(asOf: string | undefined): string {
  if (!asOf) throw new BadRequestException('asOf is required, as YYYY-MM-DD.');
  if (!DAY_KEY.test(asOf)) throw new BadRequestException('asOf must be in YYYY-MM-DD format.');
  return asOf;
}

@ApiTags('Infosys daily report')
@ApiBearerAuth()
@Controller('infosys/daily-report')
export class InfosysDailyReportController {
  constructor(private readonly report: InfosysDailyReportService) {}

  @Get()
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({
    summary: 'The wide, date-wise Infosys submission matrix up to an as-of date',
    description:
      'One row per active Infosys student, one column per assigned day from the tracking start date ' +
      'through asOf. campus/category narrow which rows are returned; the underlying data is unchanged.',
  })
  get(
    @Query('asOf') asOf: string | undefined,
    @Query('campus') campus: string | undefined,
    @Query('category') category: string | undefined,
  ) {
    return this.report.buildReport(parseAsOf(asOf), {
      campusName: campus || null,
      category: (category as InfosysCategory) || null,
    });
  }

  @Get('export')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'Download the current report view as an .xlsx workbook' })
  async export(
    @Query('asOf') asOf: string | undefined,
    @Query('campus') campus: string | undefined,
    @Query('category') category: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.report.buildWorkbook(parseAsOf(asOf), {
      campusName: campus || null,
      category: (category as InfosysCategory) || null,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="infosys-daily-report-${asOf}.xlsx"`);
    res.send(buffer);
  }
}
