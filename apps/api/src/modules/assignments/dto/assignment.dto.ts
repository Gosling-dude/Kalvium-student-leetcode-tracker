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
}

export class PreviewProblemDto {
  @ApiProperty({ example: 'https://leetcode.com/problems/two-sum/' })
  @IsString()
  @MaxLength(500)
  url!: string;
}
