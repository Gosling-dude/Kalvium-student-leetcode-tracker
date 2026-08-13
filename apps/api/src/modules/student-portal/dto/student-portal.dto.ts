import { ApiPropertyOptional } from '@nestjs/swagger';
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
   * `mine` (default) scopes to the student's own current batch, matching what §11
   * describes; `all` shows the combined board across every batch. There is no third
   * option to name an arbitrary batch — a student does not pick someone else's board by
   * id, they see their own or everyone's.
   */
  @ApiPropertyOptional({ enum: ['mine', 'all'], default: 'mine' })
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope: 'mine' | 'all' = 'mine';
}
