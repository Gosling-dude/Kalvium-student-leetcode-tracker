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

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The campus half of a filter, as it arrives in a query string.
 *
 * A free string rather than a UUID, for the same reason `BatchFilterDto.batch` is: the UI
 * and hand-written URLs carry codes (`SRM`, `vels`), and `CampusesService.resolveSelector`
 * is the single place that turns any accepted form into an id — or rejects it. Omitting
 * it, or passing `all`, means every campus.
 */
export class CampusFilterDto {
  @ApiPropertyOptional({
    description: 'Campus id or code (VELS/SRM). Omit or "all" for every campus.',
    example: 'SRM',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campus?: string;
}

/** Campus + batch together — the audience shape most listing endpoints accept. */
export class ScopeFilterDto extends CampusFilterDto {
  @ApiPropertyOptional({
    description:
      'Batch id, code (A/B) or alias (foundation/intermediate), resolved within the ' +
      'selected campus. Omit or "all" for every batch; "none" for students with no batch.',
    example: 'foundation',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;
}

export class CampusStatsQueryDto {
  @ApiPropertyOptional({ description: 'Program day to compute completion for (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  @Matches(DAY_KEY_PATTERN, { message: 'dayKey must be formatted YYYY-MM-DD' })
  dayKey?: string;
}

export class ListCampusesQueryDto {
  @ApiPropertyOptional({ description: 'Include archived campuses' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  includeArchived?: boolean;
}

export class CreateCampusDto {
  @ApiProperty({ example: 'SRM University' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiPropertyOptional({
    example: 'SRM',
    description: 'Short stable key used in URLs and filters. Derived from the name if omitted.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,24}$/, {
    message: 'Campus code may contain letters, digits and hyphens only',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  code?: string;

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

  /**
   * Whether to create the standard Foundation / Intermediate batches.
   *
   * Defaults to true because a campus with no batches cannot receive students or
   * assignments, and creating it empty is a trap the first admin falls into once.
   */
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === undefined || value === true || value === 'true')
  createDefaultBatches?: boolean;
}

export class UpdateCampusDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
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

/**
 * Transferring a student to another campus.
 *
 * `toBatchId` is optional: omitting it lands the student in the destination campus's
 * placement-pending batch, which is the honest state for someone who has not been
 * re-assessed at their new campus yet (§7, §16).
 */
export class TransferCampusDto {
  @ApiProperty({ description: 'Destination campus id' })
  @IsUUID()
  toCampusId!: string;

  @ApiPropertyOptional({
    description:
      'Destination batch id, which must belong to the destination campus. ' +
      "Omit to land the student in that campus's placement-pending batch.",
  })
  @IsOptional()
  @IsUUID()
  toBatchId?: string;

  @ApiPropertyOptional({ description: 'Why the student is being transferred', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason?: string;
}
