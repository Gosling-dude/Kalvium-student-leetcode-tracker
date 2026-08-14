/**
 * Admin password recovery endpoints — see `AdminRecoveryService` for the two paths.
 *
 * All three routes are `@Public()`: there is by definition no valid session for
 * someone using them. `deployment-secret` is instead gated by
 * `AdminRecoverySecretGuard`, the same `@Public()` + `@UseGuards(...)` combination
 * `InternalController` uses for `CronSecretGuard`. Kept as its own controller rather
 * than growing `AuthController`, so this recovery surface stays easy to find, review
 * and — if ever needed — remove as one unit.
 */

import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../../common/decorators';
import { AdminRecoverySecretGuard } from '../../common/guards/admin-recovery-secret.guard';
import { AdminRecoveryService } from './admin-recovery.service';
import {
  ConfirmAdminRecoveryDto,
  DeploymentSecretResetDto,
  RequestAdminRecoveryDto,
} from './dto/admin-recovery.dto';

@ApiTags('Admin Recovery')
@Controller('admin-recovery')
@Public()
export class AdminRecoveryController {
  constructor(private readonly recovery: AdminRecoveryService) {}

  @Post('request')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request an emailed password-reset token for an admin account',
    description:
      'Always responds 204, whether or not the email belongs to an admin account and ' +
      'whether or not email sending is configured — this endpoint never reveals which.',
  })
  @ApiResponse({ status: 204, description: 'A token was emailed if the conditions were met' })
  async request(@Body() dto: RequestAdminRecoveryDto, @Req() req: Request): Promise<void> {
    await this.recovery.requestReset(dto.email, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Post('confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Redeem an emailed reset token for a new password' })
  @ApiResponse({ status: 204, description: 'Password changed; all sessions revoked' })
  @ApiResponse({ status: 401, description: 'Token is invalid, expired, or already used' })
  async confirm(@Body() dto: ConfirmAdminRecoveryDto, @Req() req: Request): Promise<void> {
    await this.recovery.confirmReset(dto.token, dto.newPassword, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Post('deployment-secret')
  @UseGuards(AdminRecoverySecretGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: "Reset an admin's password using the ADMIN_RECOVERY_SECRET deployment secret",
    description:
      'Requires `Authorization: Bearer <ADMIN_RECOVERY_SECRET>`. Works regardless of whether ' +
      "email is configured. Returns the new password once — it is never stored in " +
      'plaintext or logged anywhere.',
  })
  @ApiResponse({ status: 200, description: 'Password reset; returns it once' })
  @ApiResponse({ status: 401, description: 'Missing/incorrect deployment secret' })
  @ApiResponse({ status: 404, description: 'No admin account with that email' })
  async deploymentSecretReset(@Body() dto: DeploymentSecretResetDto, @Req() req: Request) {
    return this.recovery.deploymentSecretReset(dto.email, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }
}
