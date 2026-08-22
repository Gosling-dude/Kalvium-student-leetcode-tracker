import { Module } from '@nestjs/common';

import { CampusesModule } from '../campuses/campuses.module';
import { ProvidersModule } from '../providers/providers.module';
import {
  BaselineTestsController,
  StudentBaselineTestsController,
} from './baseline-tests.controller';
import { BaselineTestsService } from './baseline-tests.service';

/**
 * Baseline tests — a top-level feature alongside assignments, not inside them.
 *
 * The module deliberately does not import `AssignmentsModule`, `ScoringModule` or
 * `LeaderboardModule`. There is nothing it needs from them, and having no handle on them
 * is what guarantees a baseline result cannot reach a streak, a daily completion figure
 * or a leaderboard position (§25, §39).
 */
@Module({
  imports: [CampusesModule, ProvidersModule],
  controllers: [BaselineTestsController, StudentBaselineTestsController],
  providers: [BaselineTestsService],
  exports: [BaselineTestsService],
})
export class BaselineTestsModule {}
