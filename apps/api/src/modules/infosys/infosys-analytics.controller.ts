/**
 * Read-only — scoping is enforced in `InfosysAnalyticsService`, against the same
 * `MentorScopeService` every other campus-aware endpoint uses, not here and not in the
 * frontend (mirrors `CampusAnalysisController`'s own note).
 */

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { InfosysAnalyticsService } from './infosys-analytics.service';

@ApiTags('Infosys analysis')
@ApiBearerAuth()
@Controller('infosys/analysis')
export class InfosysAnalyticsController {
  constructor(private readonly analysis: InfosysAnalyticsService) {}

  @Get('campus-summary')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'One card per Infosys campus the caller may see' })
  @ApiQuery({ name: 'campusId', required: false })
  campusSummary(@CurrentUser() user: RequestUser, @Query('campusId') campusId?: string) {
    return this.analysis.campusSummary(user, campusId);
  }

  @Get('students')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'Every Infosys student the caller may see, with weekly rows and category' })
  @ApiQuery({ name: 'campusId', required: false })
  students(@CurrentUser() user: RequestUser, @Query('campusId') campusId?: string) {
    return this.analysis.studentAnalysis(user, campusId);
  }
}
