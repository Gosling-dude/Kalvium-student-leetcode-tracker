/**
 * Admin password recovery.
 *
 * `AuthService.changePassword` requires the current password, and the seed script
 * deliberately never touches an existing admin's password on re-seed — so an ADMIN
 * locked out of their account has no path back in without this. Two independent
 * mechanisms, chosen so the app has a working recovery path whether or not email is
 * configured:
 *
 *  - `requestReset` / `confirmReset`: a one-time, single-use, 30-minute token emailed
 *    only to the admin's own registered address (never a client-supplied one), used
 *    only when `EmailService.isConfigured()`. The human who receives it chooses their
 *    own new password.
 *  - `deploymentSecretReset`: gated by `AdminRecoverySecretGuard` at the controller —
 *    a platform-env-var bearer secret, not a user session. Works regardless of email
 *    config. Generates the new password itself (CSPRNG, same generator used for
 *    student accounts) rather than accepting one from the caller.
 *
 * Both paths are scoped to `role: 'ADMIN'` only — neither can touch a MENTOR, VIEWER or
 * STUDENT account — and both revoke every existing session on success, exactly like
 * `AuthService.changePassword`. No plaintext password or token is ever written to a
 * table, a log line, or the audit log; the audit log records only the fact and target.
 */

import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../../infra/email/email.service';
import { AuthService } from './auth.service';
import { generateTempPassword } from './password-generator';

const RESET_TOKEN_TTL_MINUTES = 30;

interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface DeploymentSecretResetResult {
  email: string;
  tempPassword: string;
}

@Injectable()
export class AdminRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /**
   * Issues a reset token and emails it, but only when the email matches an ADMIN
   * account and email sending is actually configured. Always resolves regardless of
   * outcome — the caller (and the audit log) gets no signal either way, matching
   * `login`'s "unknown email vs wrong password" indistinguishability.
   */
  async requestReset(email: string, ctx: RequestContext = {}): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user || user.role !== 'ADMIN' || !this.email.isConfigured()) return;

    // Only one outstanding token at a time — a fresh request supersedes any earlier one.
    await this.prisma.adminPasswordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('hex');
    await this.prisma.adminPasswordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
        ipAddress: ctx.ipAddress ?? null,
      },
    });

    await this.email.sendEmail({
      fromEmail: this.config.email.fromEmail ?? '',
      toRecipients: [user.email],
      subject: 'Kalvium admin password reset',
      html:
        `<p>A password reset was requested for the admin account ${this.escapeHtml(user.email)}.</p>` +
        `<p>Reset token (expires in ${RESET_TOKEN_TTL_MINUTES} minutes):</p>` +
        `<p><code>${this.escapeHtml(rawToken)}</code></p>` +
        `<p>Use it with <code>POST /admin-recovery/confirm</code> ({ "token": "...", "newPassword": "..." }) ` +
        `before it expires. If you did not request this, no action is needed — the token ` +
        `cannot be used without also knowing this email, and it expires on its own.</p>`,
    });

    await this.audit.record({
      actorId: user.id,
      actorName: user.name,
      action: 'ADMIN_RECOVERY_REQUESTED',
      entityType: 'User',
      entityId: user.id,
      summary: `Emailed a password-reset token for ${user.name} <${user.email}>`,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  /**
   * Redeems a reset token for a new password. "Not found", "already used" and
   * "expired" all produce the identical error — a caller learns nothing about *why*
   * a token didn't work.
   */
  async confirmReset(token: string, newPassword: string, ctx: RequestContext = {}): Promise<void> {
    const invalid = () => new UnauthorizedException('Invalid or expired reset token');

    const stored = await this.prisma.adminPasswordResetToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });

    if (!stored || stored.usedAt || stored.expiresAt <= new Date() || stored.user.role !== 'ADMIN') {
      throw invalid();
    }

    await this.prisma.adminPasswordResetToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    });

    await this.prisma.user.update({
      where: { id: stored.user.id },
      data: {
        passwordHash: await this.auth.hashPassword(newPassword),
        passwordChangedAt: new Date(),
      },
    });

    // A password reset should end every other session — same rule as a self-service change.
    await this.auth.revokeAllSessions(stored.user.id);

    await this.audit.record({
      actorId: stored.user.id,
      actorName: stored.user.name,
      action: 'ADMIN_PASSWORD_RESET_EMAIL',
      entityType: 'User',
      entityId: stored.user.id,
      summary: `${stored.user.name} reset their password via an emailed recovery token`,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  /**
   * The deployment-secret path. Authorization already happened in the guard — this
   * just does the reset. Only ever touches an ADMIN account; anything else (unknown
   * email, or an email that belongs to a non-admin) is reported identically as "not
   * found", since the caller already holds the deployment secret and there's no
   * enumeration risk worth hiding from them.
   */
  async deploymentSecretReset(
    email: string,
    ctx: RequestContext = {},
  ): Promise<DeploymentSecretResetResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user || user.role !== 'ADMIN') {
      throw new NotFoundException(`No admin account found for ${email}`);
    }

    const tempPassword = generateTempPassword();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.auth.hashPassword(tempPassword),
        passwordChangedAt: new Date(),
      },
    });

    await this.auth.revokeAllSessions(user.id);

    await this.audit.record({
      actorId: null,
      actorName: 'Deployment secret',
      action: 'ADMIN_PASSWORD_RESET_DEPLOYMENT_SECRET',
      entityType: 'User',
      entityId: user.id,
      summary: `Reset the password for ${user.name} <${user.email}> via the deployment-secret recovery path`,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return { email: user.email, tempPassword };
  }

  /** SHA-256 rather than bcrypt: this is a high-entropy token, not a guessable
   *  password, and lookup must be an indexed equality check — same reasoning as
   *  `AuthService`'s refresh-token hashing. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
