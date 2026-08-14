import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RequestAdminRecoveryDto {
  @ApiProperty({ example: 'admin@kalvium.com' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;
}

export class ConfirmAdminRecoveryDto {
  @ApiProperty({ description: 'The token emailed by /admin-recovery/request' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  // Same policy as ChangePasswordDto.newPassword — kept in sync deliberately rather
  // than imported, since every path that sets a password validates it independently.
  @ApiProperty({ description: 'Min 10 chars, with upper, lower and a digit' })
  @IsString()
  @MinLength(10, { message: 'Password must be at least 10 characters' })
  @MaxLength(200)
  @Matches(/[a-z]/, { message: 'Password must contain a lowercase letter' })
  @Matches(/[A-Z]/, { message: 'Password must contain an uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must contain a digit' })
  newPassword!: string;
}

/** No password field: the deployment-secret path generates one — see AdminRecoveryService. */
export class DeploymentSecretResetDto {
  @ApiProperty({ example: 'admin@kalvium.com' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;
}
