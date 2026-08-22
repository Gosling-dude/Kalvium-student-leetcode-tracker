import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { STUDENT_STATUSES, SYNC_STATUSES, type StudentStatus, type SyncStatus } from '@dsa/shared';

import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** Accepts a bare handle or a pasted profile URL; both are normalised to a handle. */
const normaliseUsername = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const match = /leetcode\.com\/(?:u\/|profile\/)?([A-Za-z0-9_-]+)/i.exec(value.trim());
  return (match?.[1] ?? value.trim().replace(/^@/, '')).toLowerCase();
};

export class CreateStudentDto {
  @ApiPropertyOptional({ description: 'Campus this student belongs to' })
  @IsOptional()
  @IsUUID()
  campusId?: string;

  @ApiProperty({ example: 'Asha Menon' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({ example: 'asha.menon@kalvium.com' })
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;

  /**
   * Optional: a student can be on the roster before their handle has been collected.
   * They are simply skipped by the sync until one is set (see the schema note).
   */
  @ApiPropertyOptional({ example: 'asha_menon', description: 'Handle or full profile URL' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,39}$/, {
    message: 'LeetCode username may contain letters, digits, underscore and hyphen only',
  })
  @Transform(normaliseUsername)
  leetcodeUsername?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  squadId?: string;


  @ApiPropertyOptional({ description: 'Cohort number within the programme', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  cohort?: number | null;

  /**
   * The authoritative belt level, set from the roster and editable by an admin (§9).
   * Never computed from score, solved counts, languages or eligibility.
   */
  @ApiPropertyOptional({ description: 'Max belt level (authoritative, not derived)', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  maxBeltLevel?: number | null;

  @ApiPropertyOptional({ enum: STUDENT_STATUSES })
  @IsOptional()
  @IsIn(STUDENT_STATUSES)
  status?: StudentStatus;
}

export class UpdateStudentDto {
  /**
   * Changing this writes a `StudentCampusHistory` row, exactly as the dedicated transfer
   * endpoint does — a campus change made here must not be invisible to the audit trail.
   */
  @ApiPropertyOptional({ description: 'Campus this student belongs to' })
  @IsOptional()
  @IsUUID()
  campusId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,39}$/)
  @Transform(normaliseUsername)
  leetcodeUsername?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  batchId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  squadId?: string | null;


  @ApiPropertyOptional({ description: 'Cohort number within the programme', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  cohort?: number | null;

  /**
   * The authoritative belt level, set from the roster and editable by an admin (§9).
   * Never computed from score, solved counts, languages or eligibility.
   */
  @ApiPropertyOptional({ description: 'Max belt level (authoritative, not derived)', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  maxBeltLevel?: number | null;

  @ApiPropertyOptional({ enum: STUDENT_STATUSES })
  @IsOptional()
  @IsIn(STUDENT_STATUSES)
  status?: StudentStatus;
}

export class StudentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  squadId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  campusId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  batchId?: string;

  /**
   * Campus by id or code (`SRM`). Resolved to `campusId` by the controller before the
   * service sees it, so the service only ever deals in ids.
   */
  @ApiPropertyOptional({ description: 'Campus id or code (VELS/SRM). Omit or "all" for every campus.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campus?: string;

  /**
   * Batch by id, code (`A`) or alias (`foundation`). Resolved to `batchId` by the
   * controller before the service sees it, so the service only ever deals in ids.
   *
   * Resolved *within* `campus` when one is given — otherwise a bare `A` names a batch at
   * every campus and could not pick between them.
   */
  @ApiPropertyOptional({ description: 'Batch id, code (A/B/PENDING) or alias (foundation/intermediate/pending_placement)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;

  /** Squad number from the roster, e.g. 144. Independent of cohort and batch (§6, §13). */
  @ApiPropertyOptional({ description: 'Squad number, e.g. 144', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  squadNumber?: number;

  /**
   * Only students who have not been placed into a level yet.
   *
   * Matches both the campus's placement-pending batch and students with no batch at all,
   * because a mentor asking "who still needs placing?" means the same thing by both (§13).
   */
  @ApiPropertyOptional({ description: 'Only students awaiting placement into a batch' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  awaitingPlacement?: boolean;

  @ApiPropertyOptional({ description: 'Cohort number', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  cohort?: number;

  /**
   * Archived students are hidden by default — they have left the programme (§24). This
   * opts them back in alongside current students; `status=ARCHIVED` selects only them.
   */
  @ApiPropertyOptional({ description: 'Include students archived out of the programme' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  includeArchived?: boolean;

  @ApiPropertyOptional({ enum: STUDENT_STATUSES })
  @IsOptional()
  @IsIn(STUDENT_STATUSES)
  status?: StudentStatus;

  @ApiPropertyOptional({ enum: SYNC_STATUSES })
  @IsOptional()
  @IsIn(SYNC_STATUSES)
  syncStatus?: SyncStatus;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minStreak?: number;
}

export class BulkIdsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  // Bounded so a single request cannot ask the database to touch unbounded rows.
  @ArrayMaxSize(1000)
  @IsUUID(undefined, { each: true })
  ids!: string[];
}

export class BulkUpdateStudentsDto extends BulkIdsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  squadId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  batchId?: string | null;

  @ApiPropertyOptional({ enum: STUDENT_STATUSES })
  @IsOptional()
  @IsIn(STUDENT_STATUSES)
  status?: StudentStatus;
}

export class ImportStudentsDto {
  @ApiPropertyOptional({ description: 'Validate only; write nothing' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  dryRun?: boolean;

  @ApiPropertyOptional({ description: 'Overwrite students that already exist' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  updateExisting?: boolean;
}

export class CreateNoteDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}
