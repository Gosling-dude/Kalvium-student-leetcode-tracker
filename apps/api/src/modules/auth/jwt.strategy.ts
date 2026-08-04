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
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    if (!user) throw new UnauthorizedException('Account no longer exists');
    if (!user.isActive) throw new UnauthorizedException('Account has been deactivated');

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
    };
  }
}
