import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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

/** `YYYY-MM-DD`. Rejected at the edge so no service has to re-validate a day key. */
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A batch filter as it arrives in a query string.
 *
 * Deliberately a free string rather than a UUID: the UI and hand-written URLs use codes
 * (`A`, `foundation`), and `BatchesService.resolveSelector` is the single place that
 * turns any accepted form into an id — or rejects it. Validating it as a UUID here would
 * make `?batch=A` a 400 for no reason.
 */
export class BatchFilterDto {
  @ApiPropertyOptional({
    description: 'Batch id, code (A/B) or alias (foundation/intermediate). Omit or "all" for every batch.',
    example: 'A',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;
}

export class BatchStatsQueryDto {
  @ApiPropertyOptional({ description: 'Program day to compute completion for (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  @Matches(DAY_KEY_PATTERN, { message: 'dayKey must be formatted YYYY-MM-DD' })
  dayKey?: string;
}

export class ListBatchesQueryDto {
  @ApiPropertyOptional({ description: 'Include archived batches' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  includeArchived?: boolean;
}

/**
 * Moving a student between batches.
 *
 * `reason` is optional but encouraged — the admin UI prompts for it on every move, and
 * it is the field that makes the audit trail worth reading six weeks later.
 */
export class MoveBatchDto {
  @ApiProperty({ description: 'Destination batch id' })
  @IsUUID()
  toBatchId!: string;

  @ApiPropertyOptional({ description: 'Why the student is being moved', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason?: string;
}

export class CreateBatchDto {
  @ApiProperty({ example: 'Advanced Level' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({ example: 'C', description: 'Short stable key used in URLs and filters' })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,24}$/, {
    message: 'Batch code may contain letters, digits and hyphens only',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Display order in pickers and reports' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class UpdateBatchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsString()
  @Matches(/^(ACTIVE|ARCHIVED)$/)
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
