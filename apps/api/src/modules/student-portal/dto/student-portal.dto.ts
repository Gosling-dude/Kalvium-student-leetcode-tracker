import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** `/student/assignments` — history is paginated; nothing here accepts a batch or
 *  student id from the caller, because both are derived from the session (§18). */
export class StudentAssignmentQueryDto extends PaginationQueryDto {}

const PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

export class StudentLeaderboardQueryDto {
  @ApiPropertyOptional({ enum: PERIODS, default: 'WEEKLY' })
  @IsOptional()
  @IsIn(PERIODS)
  period: (typeof PERIODS)[number] = 'WEEKLY';

  /**
   * Which of the three boards to show — and, deliberately, the *only* way a student can
   * influence the scope.
   *
   *  * `mine` — the student's own campus + batch.
   *  * `campus` (default) — every batch at the student's own campus.
   *  * `global` — every active student across every campus (§14, §15).
   *
   * There is no option to name a campus or batch by id. A student sees their own board or
   * the global one; they never pick someone else's, which is what makes the "student
   * cannot manipulate a campus query parameter" requirement structural rather than a
   * check somebody has to remember to write (§40).
   *
   * `all` is accepted as a synonym for `global`, so links saved before campuses existed
   * keep working instead of 400ing.
   */
  @ApiPropertyOptional({ enum: ['mine', 'campus', 'global', 'all'], default: 'campus' })
  @IsOptional()
  @IsIn(['mine', 'campus', 'global', 'all'])
  @Transform(({ value }) => (value === 'all' ? 'global' : value))
  scope: 'mine' | 'campus' | 'global' = 'campus';
}
