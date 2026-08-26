/**
 * Admin-driven provisioning of mentor logins.
 *
 * Deliberately a separate service from `StudentAccountsService` rather than a shared one
 * with a role parameter. The two look similar and are not: a student account is derived
 * from a roster row and is refused to anyone not currently ACTIVE on it, while a mentor
 * account is created directly by an admin for someone who has no `Student` row at all.
 * Folding them together would mean one method carrying both sets of rules and applying the
 * wrong half whenever the role argument was wrong.
 *
 * The password rules are shared, because those genuinely are the same: CSPRNG unless the
 * programme has configured a shared initial password, hashed per account, never logged,
 * never stored in plaintext, never returned except once to the admin who created it.
 *
 * A new mentor lands with `passwordChangedAt = null`, so `ForcePasswordChangeGuard` holds
 * them at the change-password form until they set their own — the same rule students get,
 * for the same reason.
 */

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthService } from './auth.service';
import { AuditService } from '../audit/audit.service';
import { generateTempPassword } from './password-generator';
import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';

export interface ProvisionedMentor {
  userId: string;
  name: string;
  email: string;
  /** Null when the shared `SEED_STUDENT_PASSWORD` was used — the admin already has it. */
  tempPassword: string | null;
  campusIds: string[];
}

@Injectable()
export class MentorAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Same rule as student provisioning — see `StudentAccountsService.initialPassword`. */
  private initialPassword(): { password: string; disclose: boolean } {
    const shared = this.config.seed.studentPassword;
    return shared
      ? { password: shared, disclose: false }
      : { password: generateTempPassword(), disclose: true };
  }

  /**
   * Create a mentor, optionally granting campuses in the same call.
   *
   * Granting here rather than in a second request is deliberate: a mentor with no campus
   * grants can log in and see nothing, and an onboarding flow that routinely produces that
   * state teaches everyone to ignore the empty screen.
   */
  async create(
    input: { email: string; name: string; campusIds?: string[] },
    actorId: string,
  ): Promise<ProvisionedMentor> {
    const email = input.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });
    if (existing) {
      throw new BadRequestException(
        `${email} already has a ${existing.role} account. Use the reset-password action instead.`,
      );
    }

    const campusIds = [...new Set(input.campusIds ?? [])];
    if (campusIds.length > 0) {
      const found = await this.prisma.campus.count({ where: { id: { in: campusIds } } });
      if (found !== campusIds.length) {
        throw new BadRequestException('One or more campuses do not exist.');
      }
    }

    const initial = this.initialPassword();
    const user = await this.prisma.user.create({
      data: {
        email,
        name: input.name.trim(),
        role: 'MENTOR',
        passwordHash: await this.auth.hashPassword(initial.password),
        // Null on purpose: the guard holds them at the change-password form until set.
        passwordChangedAt: null,
        mentorCampuses: { create: campusIds.map((campusId) => ({ campusId })) },
      },
      select: { id: true, name: true, email: true },
    });

    await this.audit.record({
      actorId,
      action: 'MENTOR_ACCOUNT_CREATED',
      entityType: 'User',
      entityId: user.id,
      summary: `Created mentor account for ${user.name} <${user.email}>`,
      // Campuses, never the password.
      metadata: { campusIds },
    });

    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      tempPassword: initial.disclose ? initial.password : null,
      campusIds,
    };
  }

  /** Reset one mentor's password and end their existing sessions. */
  async resetPassword(userId: string, actorId: string): Promise<ProvisionedMentor> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        mentorCampuses: { select: { campusId: true } },
      },
    });
    if (!user) throw new NotFoundException(`User ${userId} was not found`);
    if (user.role !== 'MENTOR') {
      // Admin recovery is a separate, deliberately narrower path; students have their own.
      throw new BadRequestException(
        `${user.email} is a ${user.role}, not a mentor. Use the matching reset action for that role.`,
      );
    }

    const initial = this.initialPassword();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.auth.hashPassword(initial.password),
        passwordChangedAt: null,
        isActive: true,
      },
    });
    // A reset password must not leave old sessions alive under the old credential.
    await this.auth.revokeAllSessions(user.id);

    await this.audit.record({
      actorId,
      action: 'MENTOR_PASSWORD_RESET',
      entityType: 'User',
      entityId: user.id,
      summary: `Reset the password for mentor ${user.name} <${user.email}>`,
    });

    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      tempPassword: initial.disclose ? initial.password : null,
      campusIds: user.mentorCampuses.map((grant) => grant.campusId),
    };
  }
}
