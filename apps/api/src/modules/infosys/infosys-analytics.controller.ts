/**
 * One cohort, not campus-divided — see `InfosysAnalyticsService`'s header comment.
 * ADMIN/MENTOR/VIEWER all see the same whole-cohort dashboard and student list; there
 * is no campus query parameter and no campus-specific authorization logic here (§14 of
 * the simplification brief). A STUDENT sees only their own row, via `/infosys/me`,
 * resolved from their JWT exactly like `StudentPortalController` does — never from a
 * client-supplied id.
 */

import { Controller, ForbiddenException, Get, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, Roles, type RequestUser } from '../../common/decorators';
import { InfosysAnalyticsService } from './infosys-analytics.service';

@ApiTags('Infosys analysis')
@ApiBearerAuth()
@Controller('infosys')
export class InfosysAnalyticsController {
  constructor(private readonly analysis: InfosysAnalyticsService) {}

  @Get('dashboard')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'One dashboard for the whole Infosys cohort — no campus breakdown' })
  dashboard() {
    return this.analysis.dashboard();
  }

  @Get('students')
  @Roles('ADMIN', 'MENTOR', 'VIEWER')
  @ApiOperation({ summary: 'Every Infosys student, whole cohort, with weekly rows and category' })
  students() {
    return this.analysis.studentAnalysis();
  }

  @Get('me')
  @Roles('STUDENT')
  @ApiOperation({ summary: 'The logged-in student’s own Infosys data' })
  async me(@CurrentUser() user: RequestUser) {
    if (!user.studentId) {
      throw new ForbiddenException('This account has no linked student record.');
    }
    const analysis = await this.analysis.studentAnalysisFor(user.studentId);
    if (!analysis) {
      throw new NotFoundException('You are not enrolled in Infosys Preparation.');
    }
    return analysis;
  }
}
