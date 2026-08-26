import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import {
  AllowsUnchangedPassword,
  CurrentUser,
  Public,
  Roles,
  type RequestUser,
} from '../../common/decorators';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshTokenDto } from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Tighter than the global limit: login is the endpoint worth brute-forcing.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in and receive an access/refresh token pair' })
  @ApiResponse({ status: 200, description: 'Authenticated' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate a refresh token for a new token pair' })
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  // These three are the entire "account" surface every role shares — including STUDENT,
  // explicitly, since `RolesGuard` denies students by default on anything undecorated.
  // Each derives identity from the authenticated session only, never a param, so there
  // is nothing here for a student to reach beyond their own account.
  //
  // They are also the only routes `ForcePasswordChangeGuard` lets through for an account
  // still on its handed-over password: without `me` the client cannot tell why it was
  // blocked, and without `change-password` there would be no way out of the block at all.

  @Get('me')
  @AllowsUnchangedPassword()
  @Roles('MENTOR', 'VIEWER', 'STUDENT')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The currently authenticated user' })
  me(@CurrentUser() user: RequestUser) {
    return this.auth.getProfile(user.id);
  }

  @Post('change-password')
  @AllowsUnchangedPassword()
  @Roles('MENTOR', 'VIEWER', 'STUDENT')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change your password and end all other sessions' })
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  @Post('logout-all')
  @AllowsUnchangedPassword()
  @Roles('MENTOR', 'VIEWER', 'STUDENT')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke every session for the current user' })
  async logoutAll(@CurrentUser() user: RequestUser): Promise<void> {
    await this.auth.revokeAllSessions(user.id);
  }
}
