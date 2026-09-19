import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateInfosysAssignmentDto {
  @ApiProperty({ example: '2026-09-20', description: 'The date the questions were actually given, YYYY-MM-DD — not the date this is entered (§4).' })
  @IsString()
  @Matches(DAY_KEY, { message: 'dayKey must be in YYYY-MM-DD format' })
  dayKey!: string;

  @ApiProperty({
    type: [String],
    example: [
      'https://leetcode.com/problems/two-sum/',
      'https://leetcode.com/problems/valid-parentheses/',
      'https://leetcode.com/problems/merge-intervals/',
      'https://leetcode.com/problems/lru-cache/',
    ],
    description: 'Problem URLs or slugs. Four is the default; 1-10 is accepted (§3: not hardcoded).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  problemUrls!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateInfosysAssignmentDto {
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
  @MaxLength(4000)
  notes?: string;
}
