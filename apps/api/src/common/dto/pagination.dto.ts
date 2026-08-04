import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PAGINATION, type Paginated } from '@dsa/shared';

/**
 * Shared pagination and sorting input.
 *
 * `pageSize` is hard-capped: without a ceiling, `?pageSize=100000` is an unauthenticated
 * way to make the database do arbitrary work.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: PAGINATION.defaultPage })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = PAGINATION.defaultPage;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: PAGINATION.maxPageSize,
    default: PAGINATION.defaultPageSize,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION.maxPageSize)
  pageSize: number = PAGINATION.defaultPageSize;

  @ApiPropertyOptional({ description: 'Free-text search term' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;

  @ApiPropertyOptional({ description: 'Field to sort by' })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';

  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }

  get take(): number {
    return this.pageSize;
  }
}

export function paginate<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): Paginated<T> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

/**
 * Whitelist a client-supplied sort field against columns we actually allow.
 *
 * Passing user input straight into Prisma's `orderBy` lets a caller sort by any column
 * on the model, including ones that should not be enumerable.
 */
export function safeSortField<T extends string>(
  requested: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(requested as T) ? (requested as T) : fallback;
}
