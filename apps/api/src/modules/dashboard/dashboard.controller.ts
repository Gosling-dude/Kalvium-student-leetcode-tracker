import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type RequestUser } from '../../common/decorators';
import { CampusesService } from '../campuses/campuses.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly campuses: CampusesService,
    private readonly mentorScope: MentorScopeService,
  ) {}

  /**
   * The campus these endpoints must actually run under.
   *
   * `resolveScope` validates what the *request* asked for; it has no idea who is asking.
   * That was the whole bug: a mentor scoped to Vels who sent `?campus=SRM` — or who sent
   * no campus at all, which means "every campus" here — got exactly what they asked for,
   * because the only campus check in the request lived on the client. Authorization has
   * to be re-derived from the grants on every request, since anything the browser is told
   * it can also change.
   *
   * Returns `null` when the caller may see nothing, which both routes below answer as an
   * empty result rather than a 403 — the same rule the student directory follows, so a
   * campus id cannot be used to probe which campuses exist.
   */
  private async scopeFor(
    user: RequestUser,
    campus: string | undefined,
    batch: string | undefined,
  ) {
    const allowed = await this.mentorScope.allowedCampusIds(user);
    // These two routes answer a denial with an empty result rather than the error
    // `resolveScopeFor` raises: they back the landing page a mentor is redirected to, and
    // an empty tracker reads as "nothing to show" while an error page reads as broken.
    // The scoping rule itself is the shared one.
    const resolved = await this.campuses.resolveScope({ campus, batch });
    const scoped = this.mentorScope.reportingScope(resolved.campusId, allowed);
    if ('deny' in scoped) return null;
    return { ...resolved, campusId: scoped.campusId };
  }

  /**
   * Both filters are resolved as a pair, and both are applied server-side.
   *
   * Returning every campus's numbers for the client to filter would be wrong twice over:
   * it leaks one campus's figures to a mentor scoped to another, and it moves an
   * aggregation over the whole roster into the browser, which is exactly what §12 and §27
   * rule out.
   */
  @Get('dashboard')
  @ApiOperation({
    summary: 'Headline statistics for a program day — global, per campus, or per batch',
  })
  @ApiQuery({ name: 'dayKey', required: false, example: '2026-08-04' })
  @ApiQuery({
    name: 'campus',
    required: false,
    example: 'SRM',
    description:
      'Campus id or code. Omit or "all" for every campus you may see. A mentor is held ' +
      'to their granted campuses regardless of what is passed here.',
  })
  @ApiQuery({ name: 'batch', required: false, example: 'A', description: 'Batch id, code or alias' })
  async stats(
    @CurrentUser() user: RequestUser,
    @Query('dayKey') dayKey?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.scopeFor(user, campus, batch);
    if (!scope) return this.dashboard.emptyStats(dayKey);

    return this.dashboard.getStats(dayKey, {
      campusId: scope.campusId,
      batchId: scope.batchId,
      onlyUnassigned: scope.onlyUnassigned,
    });
  }

  @Get('mentor/dashboard')
  @ApiOperation({
    summary: 'The daily tracker: "solved N" tables, split by campus and batch',
  })
  @ApiQuery({ name: 'dayKey', required: false })
  @ApiQuery({ name: 'squadId', required: false })
  @ApiQuery({ name: 'campus', required: false, description: 'Campus id or code' })
  @ApiQuery({ name: 'batch', required: false, description: 'Batch id, code or alias' })
  async mentor(
    @CurrentUser() user: RequestUser,
    @Query('dayKey') dayKey?: string,
    @Query('squadId') squadId?: string,
    @Query('campus') campus?: string,
    @Query('batch') batch?: string,
  ) {
    const scope = await this.scopeFor(user, campus, batch);
    if (!scope) return this.dashboard.emptyMentorDashboard(dayKey);

    return this.dashboard.getMentorDashboard(dayKey, {
      squadId,
      campusId: scope.campusId,
      batchId: scope.batchId,
      onlyUnassigned: scope.onlyUnassigned,
    });
  }
}
