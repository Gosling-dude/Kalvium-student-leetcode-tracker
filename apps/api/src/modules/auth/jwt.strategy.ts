import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { UserRole } from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { RequestUser } from '../../common/decorators';
import type { JwtPayload } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    @Inject(CONFIG_TOKEN) config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.auth.accessSecret,
    });
  }

  /**
   * The user is re-read on every request rather than trusted from the token body.
   *
   * It costs one indexed lookup, and it means deactivating an account or changing a
   * role takes effect immediately instead of whenever the access token happens to
   * expire — which for a mentor platform is the difference between revoking access and
   * hoping it lapses.
   */
  async validate(payload: JwtPayload): Promise<RequestUser> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('A refresh token cannot be used to authorize a request');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        studentId: true,
        passwordChangedAt: true,
        student: { select: { status: true } },
      },
    });

    if (!user) throw new UnauthorizedException('Account no longer exists');
    if (!user.isActive) throw new UnauthorizedException('Account has been deactivated');

    // A student's access ends the moment they are archived, not whenever their current
    // access token happens to expire — the same re-read-on-every-request reasoning as
    // `isActive` above, applied to the fact that actually governs a student's standing.
    if (user.role === 'STUDENT' && user.student?.status !== 'ACTIVE') {
      throw new UnauthorizedException(
        'Your student account is currently inactive. Please contact your mentor/program team.',
      );
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
      studentId: user.studentId,
      // Never set means never changed: the account is still on the password it was
      // handed. `ForcePasswordChangeGuard` turns that fact into an actual restriction.
      mustChangePassword: user.passwordChangedAt === null,
    };
  }
}
