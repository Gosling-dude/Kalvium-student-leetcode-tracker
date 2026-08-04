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

  @ApiProperty({ example: 'asha_menon', description: 'Handle or full profile URL' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,39}$/, {
    message: 'LeetCode username may contain letters, digits, underscore and hyphen only',
  })
  @Transform(normaliseUsername)
  leetcodeUsername!: string;

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
  groupId?: string;

  @ApiPropertyOptional({ enum: STUDENT_STATUSES })
  @IsOptional()
  @IsIn(STUDENT_STATUSES)
  status?: StudentStatus;
}

export class UpdateStudentDto {
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
  groupId?: string | null;

  @ApiPropertyOptional({ enum: STUDENT_STATUSES })
  @IsOptional()
  @IsIn(STUDENT_STATUSES)
  status?: StudentStatus;
}

export class StudentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  batchId?: string;

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
  groupId?: string | null;

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
