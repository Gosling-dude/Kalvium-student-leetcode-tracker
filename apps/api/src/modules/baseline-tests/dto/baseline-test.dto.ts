import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  BASELINE_ATTEMPT_STATUSES,
  BASELINE_REVIEW_STATUSES,
  BASELINE_TEST_STATUSES,
  type BaselineAttemptStatus,
  type BaselineReviewStatus,
  type BaselineTestStatus,
} from '@dsa/shared';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** One problem on a baseline test, with an optional weight override. */
export class BaselineProblemDto {
  @ApiProperty({ example: 'https://leetcode.com/problems/two-sum/' })
  @IsString()
  @MaxLength(500)
  url!: string;

  /**
   * Points this problem is worth. Defaults by difficulty (Easy 10, Medium 20, Hard 30)
   * so a mixed test scores sensibly without an admin hand-entering weights every week.
   */
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  points?: number;
}

export class CreateBaselineTestDto {
  @ApiProperty({ example: 'Baseline Test #3' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({ example: '2026-08-22', description: 'Program-local date, YYYY-MM-DD' })
  @IsString()
  @Matches(DAY_KEY, { message: 'dayKey must be in YYYY-MM-DD format' })
  dayKey!: string;

  /**
   * Audience, resolved exactly like an assignment's: omit `campus` for every campus, omit
   * `batch` for every batch within it. A batch always pins its own campus, so the illegal
   * "batch without campus" pair cannot be expressed.
   */
  @ApiPropertyOptional({ example: 'SRM', description: 'Campus id or code. Omit for every campus.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campus?: string;

  @ApiPropertyOptional({ example: 'foundation', description: 'Batch id, code or alias.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;

  @ApiProperty({ type: [BaselineProblemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BaselineProblemDto)
  problems!: BaselineProblemDto[];

  @ApiPropertyOptional({ default: 60, description: "One student's window, in minutes" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(600)
  durationMinutes?: number;

  @ApiPropertyOptional({ description: 'When the test opens (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  opensAt?: string;

  @ApiPropertyOptional({ description: 'When the test closes (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  closesAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Shown to students on the start screen' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;

  /**
   * Mentor-only. Never reaches a student response — `StudentBaselineTest` has no such
   * field, so it cannot leak by someone forgetting to strip it (§22).
   */
  @ApiPropertyOptional({ description: 'Mentor-only notes. Never shown to students.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  adminNotes?: string;
}

export class UpdateBaselineTestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(DAY_KEY)
  dayKey?: string;

  @ApiPropertyOptional({ description: 'Editable only while the test is a DRAFT' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campus?: string;

  @ApiPropertyOptional({ description: 'Editable only while the test is a DRAFT' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;

  @ApiPropertyOptional({ type: [BaselineProblemDto], description: 'Editable only while DRAFT' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => BaselineProblemDto)
  problems?: BaselineProblemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(600)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  opensAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  closesAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  instructions?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  adminNotes?: string;
}

export class BaselineTestQueryDto {
  @ApiPropertyOptional({ enum: BASELINE_TEST_STATUSES })
  @IsOptional()
  @IsIn(BASELINE_TEST_STATUSES)
  status?: BaselineTestStatus;

  @ApiPropertyOptional({ description: 'Campus id or code. Omit or "all" for every campus.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campus?: string;

  @ApiPropertyOptional({ description: 'Batch id, code or alias, resolved within `campus`.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @Matches(DAY_KEY)
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @Matches(DAY_KEY)
  to?: string;
}

const SETTABLE_STATUSES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED'] as const;

export class SetBaselineStatusDto {
  @ApiProperty({ enum: SETTABLE_STATUSES })
  @IsIn(SETTABLE_STATUSES)
  status!: (typeof SETTABLE_STATUSES)[number];
}

/**
 * A mentor's conclusion on a flagged attempt.
 *
 * `note` is strongly encouraged and is what makes the trail worth reading later: the
 * system records *what it observed*, and this records *what a human concluded about it*.
 * Neither is a verdict the system reaches on its own (§23).
 */
export class ReviewAttemptDto {
  @ApiProperty({ enum: BASELINE_REVIEW_STATUSES })
  @IsIn(BASELINE_REVIEW_STATUSES)
  reviewStatus!: BaselineReviewStatus;

  @ApiPropertyOptional({ description: 'What the reviewer concluded', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  note?: string;
}

/**
 * Filtering and sorting for the student-wise leaderboard.
 *
 * None of these change a student's `rank` — that is computed across the whole eligible
 * cohort before any of this is applied, so filtering to one squad shows those students
 * with their standing among everyone, not renumbered 1..n.
 */
export class BaselineLeaderboardQueryDto {
  @ApiPropertyOptional({ description: 'Matches student name, email or squad.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ description: 'Squad name, exact match.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  squad?: string;

  @ApiPropertyOptional({
    enum: [...BASELINE_ATTEMPT_STATUSES, 'ALL'],
    description: 'Narrow to one participation state. Defaults to every student.',
  })
  @IsOptional()
  @IsIn([...BASELINE_ATTEMPT_STATUSES, 'ALL'])
  status?: BaselineAttemptStatus | 'ALL';

  @ApiPropertyOptional({ enum: ['rank', 'name', 'squad', 'solved', 'percent'] })
  @IsOptional()
  @IsIn(['rank', 'name', 'squad', 'solved', 'percent'])
  sort?: 'rank' | 'name' | 'squad' | 'solved' | 'percent';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';
}
