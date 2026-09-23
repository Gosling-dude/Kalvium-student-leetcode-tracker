import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateInfosysStudentDto {
  @ApiPropertyOptional({ example: 'Rikhil Taneja' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'rikhil.taneja@kalvium.community' })
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional({ description: 'Campus id — must already exist; this endpoint never creates one.' })
  @IsOptional()
  @IsUUID()
  campusId?: string;

  @ApiPropertyOptional({
    example: 'https://leetcode.com/u/rikhiltaneja/',
    description:
      'A pasted LeetCode profile URL, or a bare handle. The username is extracted and verified live ' +
      'before saving — never inferred from name/email, never trusted on format alone. Pass an empty ' +
      'string to explicitly clear an existing profile.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  leetcodeProfileUrl?: string;
}
