import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { BLOCKER_CATEGORIES, EMAIL_REPORT_STATUSES, type BlockerCategory } from '@dsa/shared';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Recipient set shared by generate-email and preview. Every address is validated. */
export class RecipientsDto {
  @ApiProperty({ example: 'mentor@kalvium.community' })
  @IsEmail()
  @Transform(trimLower)
  fromEmail!: string;

  @ApiProperty({ type: [String], example: ['campus.manager@kalvium.community'] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true, message: 'Every "to" recipient must be a valid email address' })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => String(v).trim().toLowerCase()) : value,
  )
  toRecipients!: string[];

  @ApiPropertyOptional({ type: [String], example: ['program.head@kalvium.community'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true, message: 'Every "cc" recipient must be a valid email address' })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => String(v).trim().toLowerCase()) : value,
  )
  ccRecipients?: string[];

  @ApiPropertyOptional({ description: 'Overrides the default subject line' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  subject?: string;
}

export class GenerateEmailDto extends RecipientsDto {
  @ApiPropertyOptional({ description: 'Optional squad filter, applied the same as the dashboard' })
  @IsOptional()
  @IsUUID()
  squadId?: string;

  /**
   * Which batch this report covers. Omitted produces the overall report across every
   * batch; supplying one produces "Foundation"/"Intermediate" reports that can be
   * generated, approved and sent independently of each other (§13).
   */
  @ApiPropertyOptional({ description: 'Batch this report covers. Omit for the overall report.' })
  @IsOptional()
  @IsUUID()
  batchId?: string;
}

export class PreviewEmailDto {
  @ApiProperty({ description: 'The draft/pending EmailReport to re-render' })
  @IsUUID()
  emailReportId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @Transform(trimLower)
  fromEmail?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => String(v).trim().toLowerCase()) : value,
  )
  toRecipients?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => String(v).trim().toLowerCase()) : value,
  )
  ccRecipients?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  subject?: string;
}

export class ApproveEmailDto {
  @ApiProperty()
  @IsUUID()
  emailReportId!: string;
}

export class SendEmailDto {
  @ApiProperty()
  @IsUUID()
  emailReportId!: string;

  @ApiPropertyOptional({
    description: 'Required to resend a report for a day that already has a SENT email',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class CreateBlockerDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ example: '2026-08-08' })
  @IsString()
  dayKey!: string;

  @ApiProperty({ enum: BLOCKER_CATEGORIES })
  @IsIn(BLOCKER_CATEGORIES)
  category!: BlockerCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  actionTaken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  followUpRequired?: boolean;

  @ApiPropertyOptional({ example: '2026-08-09' })
  @IsOptional()
  @IsString()
  followUpDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  mentorNotes?: string;
}

export class UpdateBlockerDto {
  @ApiPropertyOptional({ enum: BLOCKER_CATEGORIES })
  @IsOptional()
  @IsIn(BLOCKER_CATEGORIES)
  category?: BlockerCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  actionTaken?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  followUpRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  followUpDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Transform(trim)
  mentorNotes?: string;

  @ApiPropertyOptional({ description: 'Marks the blocker resolved' })
  @IsOptional()
  @IsBoolean()
  resolved?: boolean;
}

export class ListEmailHistoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  dayKey?: string;

  @ApiPropertyOptional({ description: 'Batch id, code (A/B) or alias' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  batch?: string;

  @ApiPropertyOptional({ enum: EMAIL_REPORT_STATUSES })
  @IsOptional()
  @IsIn(EMAIL_REPORT_STATUSES)
  status?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  pageSize?: number = 25;
}
