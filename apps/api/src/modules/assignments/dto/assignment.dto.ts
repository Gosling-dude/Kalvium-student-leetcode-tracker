import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { DIFFICULTIES, type Difficulty } from '@dsa/shared';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAssignmentDto {
  @ApiProperty({ example: '2026-08-04', description: 'Program-local date, YYYY-MM-DD' })
  @IsString()
  @Matches(DAY_KEY, { message: 'date must be in YYYY-MM-DD format' })
  dayKey!: string;

  /**
   * Which batches receive this problem set.
   *
   * Omitted means every active batch — the "All" option in the UI — and creates one
   * assignment *per batch* rather than a single shared row. Separate rows are what let
   * a batch's problems be edited later without touching the other's, and what make
   * "which set was this student evaluated against" answerable from the row itself.
   *
   * To give two batches *different* problems on the same day, post twice: once per
   * batch, each with its own `problemUrls`.
   */
  @ApiPropertyOptional({
    type: [String],
    example: ['A'],
    description: 'Batch ids, codes (A/B) or aliases. Omit for all active batches.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  batches?: string[];

  @ApiProperty({
    type: [String],
    example: [
      'https://leetcode.com/problems/two-sum/',
      'https://leetcode.com/problems/valid-parentheses/',
      'https://leetcode.com/problems/merge-intervals/',
      'https://leetcode.com/problems/lru-cache/',
    ],
    description: 'Problem URLs or slugs. Four is the programme default; 1–10 is accepted.',
  })
  @IsArray()
  // The programme assigns four a day, but pinning the schema to exactly four would
  // make a short revision week impossible to record.
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  problemUrls!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ example: 'Sliding Window' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  topic?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiPropertyOptional({ enum: DIFFICULTIES })
  @IsOptional()
  @IsIn(DIFFICULTIES)
  difficulty?: Difficulty;
}

export class UpdateAssignmentDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  problemUrls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  topic?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @ApiPropertyOptional({ enum: DIFFICULTIES })
  @IsOptional()
  @IsIn(DIFFICULTIES)
  difficulty?: Difficulty;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class AssignmentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-07-01' })
  @IsOptional()
  @Matches(DAY_KEY)
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-04' })
  @IsOptional()
  @Matches(DAY_KEY)
  to?: string;

  @ApiPropertyOptional({ description: 'Batch id, code (A/B) or alias. Omit for all batches.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;
}

/** `GET /assignments/day/:dayKey?batch=` — the day's set for one batch, or all of them. */
export class AssignmentDayQueryDto {
  @ApiPropertyOptional({ description: 'Batch id, code (A/B) or alias. Omit for all batches.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;
}

/** `PATCH /assignments/:id/target` — "Change Assignment Target" (§9). */
export class ChangeAssignmentTargetDto {
  @ApiProperty({
    example: 'FOUNDATION',
    description: 'Batch id, code (A/B), alias (foundation/intermediate), or "BOTH" for every batch.',
  })
  @IsString()
  @MaxLength(64)
  target!: string;

  @ApiPropertyOptional({ description: 'Why the audience is changing — recorded in the audit trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PreviewProblemDto {
  @ApiProperty({ example: 'https://leetcode.com/problems/two-sum/' })
  @IsString()
  @MaxLength(500)
  url!: string;
}
