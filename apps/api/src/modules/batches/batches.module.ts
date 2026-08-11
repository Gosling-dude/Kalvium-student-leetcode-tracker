import { Module } from '@nestjs/common';

import { BatchesService } from './batches.service';

/**
 * The batch *domain* service, with no module dependencies of its own.
 *
 * Kept deliberately free of imports so that the many modules needing batch resolution —
 * students, assignments, scoring, dashboard, leaderboard, reports, email — can depend on
 * it without creating a cycle. The HTTP layer lives in `BatchesHttpModule`, which is
 * where the dependency on `StudentsModule` (for listing a batch's students) belongs.
 */
@Module({
  providers: [BatchesService],
  exports: [BatchesService],
})
export class BatchesModule {}
