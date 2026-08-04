/**
 * Authentication.
 *
 * Self-contained JWT auth rather than a hosted provider: it needs no external account
 * or API keys to run, which keeps `docker compose up` a genuinely one-command start,
 * and it satisfies the authentication, authorization and audit requirements directly.
 *
 * Refresh tokens are persisted as hashes and rotated on every use, so a stolen refresh
 * token is usable at most once and its reuse is detectable.
 */

import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, LoginResponse, UserRole } from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * `jsonwebtoken` accepts either seconds or a duration string such as `15m`, but its
 * types model the string form as a narrow template literal that a value read from the
 * environment can never satisfy. The value is validated at the edge (config) and this
 * cast keeps the runtime behaviour — durations like `15m` and `7d` — intact.
 */
function toExpiry(ttl: string): number {
  return ttl as unknown as number;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  type: 'access' | 'refresh';
}

interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  async login(email: string, password: string, ctx: SessionContext = {}): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Same rejection for "no such user" and "wrong password", and a hash comparison
    // runs either way — otherwise response timing reveals which emails are registered.
    const hash = user?.passwordHash ?? (await this.dummyHash());
    const matches = await bcrypt.compare(password, hash);

    if (!user || !matches) {
      await this.audit.record({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        summary: `Failed login attempt for ${email}`,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) throw new ForbiddenException('This account has been deactivated');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.record({
      actorId: user.id,
      actorName: user.name,
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      summary: `${user.name} signed in`,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return this.issueTokens(this.toAuthUser(user), ctx);
  }

  /**
   * Exchange a refresh token for a new pair, revoking the old one.
   *
   * Reuse of an already-revoked token is treated as compromise: every session for that
   * user is revoked, because the legitimate holder and the attacker are indistinguishable.
   */
  async refresh(refreshToken: string, ctx: SessionContext = {}): Promise<LoginResponse> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.auth.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Provided token is not a refresh token');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored) throw new UnauthorizedException('Refresh token not recognised');

    if (stored.revokedAt) {
      this.logger.warn(`Refresh token reuse detected for user ${stored.userId}`);
      await this.revokeAllSessions(stored.userId);
      await this.audit.record({
        actorId: stored.userId,
        action: 'REFRESH_TOKEN_REUSE',
        entityType: 'User',
        entityId: stored.userId,
        summary: 'Revoked all sessions after refresh-token reuse',
        ipAddress: ctx.ipAddress,
      });
      throw new UnauthorizedException('Refresh token has already been used');
    }

    if (stored.expiresAt <= new Date()) {
      throw new UnauthorizedException('Refresh token has expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || !user.isActive) throw new UnauthorizedException('Account is no longer active');

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(this.toAuthUser(user), ctx);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async getProfile(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Account not found');
    return this.toAuthUser(user);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Account not found');

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) throw new UnauthorizedException('Current password is incorrect');

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.hashPassword(newPassword) },
    });

    // A password change should end every other session — that is the point of changing it.
    await this.revokeAllSessions(userId);

    await this.audit.record({
      actorId: userId,
      actorName: user.name,
      action: 'PASSWORD_CHANGED',
      entityType: 'User',
      entityId: userId,
      summary: `${user.name} changed their password`,
    });
  }

  hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.config.auth.bcryptRounds);
  }

  /** Purge expired and revoked tokens. Called by the nightly rollup. */
  async pruneExpiredTokens(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { revokedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } },
        ],
      },
    });
    return result.count;
  }

  // -------------------------------------------------------------------------

  private async issueTokens(user: AuthUser, ctx: SessionContext): Promise<LoginResponse> {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role, type: 'access' } satisfies JwtPayload,
      { secret: this.config.auth.accessSecret, expiresIn: toExpiry(this.config.auth.accessTtl) },
    );

    // A random jti keeps two refreshes issued in the same second from colliding on
    // the token hash's unique index.
    const refreshToken = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        type: 'refresh',
        jti: randomBytes(16).toString('hex'),
      },
      { secret: this.config.auth.refreshSecret, expiresIn: toExpiry(this.config.auth.refreshTtl) },
    );

    const decoded = this.jwt.decode(refreshToken) as { exp?: number } | null;
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 7 * 86_400_000);

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });

    const accessDecoded = this.jwt.decode(accessToken) as { exp?: number } | null;
    const expiresIn = accessDecoded?.exp
      ? Math.max(0, accessDecoded.exp - Math.floor(Date.now() / 1000))
      : 900;

    return { user, accessToken, refreshToken, expiresIn };
  }

  /** SHA-256 rather than bcrypt: these are high-entropy tokens, not guessable passwords,
   *  and lookup must be an indexed equality check rather than a scan-and-compare. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private dummyHash(): Promise<string> {
    return bcrypt.hash('invalid-placeholder-password', this.config.auth.bcryptRounds);
  }

  private toAuthUser(user: {
    id: string;
    email: string;
    name: string;
    role: string;
    avatarUrl: string | null;
  }): AuthUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
      avatarUrl: user.avatarUrl,
    };
  }
}
