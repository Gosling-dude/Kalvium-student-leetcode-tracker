import { Module } from '@nestjs/common';

import { CampusesService } from './campuses.service';
import { MentorScopeService } from './mentor-scope.service';

/**
 * The campus *domain* service, with no module dependencies of its own.
 *
 * Deliberately import-free for the same reason `BatchesModule` is: nearly every module —
 * students, assignments, scoring, dashboard, leaderboard, baseline tests, reports, email —
 * needs campus resolution, and any dependency here would turn one of those into a cycle.
 * The HTTP layer lives in `CampusesHttpModule`.
 */
@Module({
  providers: [CampusesService, MentorScopeService],
  exports: [CampusesService, MentorScopeService],
})
export class CampusesModule {}
