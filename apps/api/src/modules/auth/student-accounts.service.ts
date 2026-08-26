/**
 * Admin-driven provisioning of student portal logins.
 *
 * This is "Option C" from the brief: an admin creates or resets a student's account and
 * hands them a temporary password out of band (in person, over the program's existing
 * comms channel — never email, since `EMAIL_PROVIDER` may not even be configured). The
 * student is expected to change it on first use, and `User.passwordChangedAt` staying null
 * is what makes that mandatory rather than a suggestion — `ForcePasswordChangeGuard`
 * refuses every other route until it is set.
 *
 * ## The shared initial password
 *
 * `SEED_STUDENT_PASSWORD` makes every newly provisioned account start from one value the
 * programme can read out to a room, instead of 250 individually-delivered strings. It is
 * off by default, and it is only defensible *because* of the guard above: an unchanged
 * initial password reaches a change-password form and nothing else, so knowing the shared
 * value is not knowing a student's data. Each account still gets its own bcrypt hash and
 * salt — "shared" describes the plaintext handed out, never anything stored.
 *
 * What this deliberately does NOT do:
 *  - No predictable password (email, name, student id). When no shared initial password
 *    is configured every password is drawn from a CSPRNG, never `Math.random`.
 *  - No plaintext password ever written to a table, a log line, or the audit log. It
 *    exists only in the return value of the call that generated it, once — and when it is
 *    the shared value, it is not even that: `tempPassword` is returned as null, because
 *    the admin already knows it and echoing it 250 times only widens where it can leak.
 *  - No account for anyone who is not currently `ACTIVE` on the roster — an archived
 *    student is exactly who this system must keep out (§25).
 */

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthService } from './auth.service';
import { AuditService } from '../audit/audit.service';
import { generateTempPassword } from './password-generator';
import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';

export interface ProvisionedAccount {
  studentId: string;
  name: string;
  email: string;  // Always present: an account cannot exist without one.
  /**
   * The plaintext to hand over, or `null` when the shared `SEED_STUDENT_PASSWORD` was
   * used and the admin already knows it. Present exactly once, in this response, and
   * never persisted or logged.
   */
  tempPassword: string | null;
}

export interface SkippedStudent {
  studentId: string;
  name: string;
  email: string;
  reason: string;
}

export interface StudentAccountRow {
  studentId: string;
  name: string;
  /** Null when the roster has not supplied one yet — such a student cannot have a login. */
  email: string | null;
  batchCode: string | null;
  hasAccount: boolean;
  isActive: boolean | null;
  lastLoginAt: string | null;
}

@Injectable()
export class StudentAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /**
   * The initial password for a newly provisioned account, and whether it is safe to hand
   * back to the caller.
   *
   * When the programme has configured a shared value the admin already has it, so it is
   * not echoed in the response: repeating a single still-valid password across 250 rows of
   * an API payload only multiplies the places it can be captured or pasted.
   */
  private initialPassword(): { password: string; disclose: boolean } {
    const shared = this.config.seed.studentPassword;
    return shared
      ? { password: shared, disclose: false }
      : { password: generateTempPassword(), disclose: true };
  }

  /**
   * Create a login for every currently-ACTIVE student who does not already have one.
   * Idempotent: re-running only ever provisions students newly missing an account.
   */
  async provisionMissingAccounts(actorId: string): Promise<{
    provisioned: ProvisionedAccount[];
    skipped: SkippedStudent[];
  }> {
    const candidates = await this.prisma.student.findMany({
      where: { status: 'ACTIVE', user: null },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });

    const provisioned: ProvisionedAccount[] = [];
    const skipped: SkippedStudent[] = [];

    for (const student of candidates) {
      // No email, no login. A student can legitimately exist before their address is
      // known — the roster is allowed to arrive incomplete — so this is a reported skip
      // with the reason, not an error and not an invented address.
      if (!student.email) {
        skipped.push({
          studentId: student.id,
          name: student.name,
          email: '',
          reason: 'EMAIL_REQUIRED: no email address on the student record yet',
        });
        continue;
      }

      // The email might already belong to a *different* login (a mentor who is also,
      // confusingly, on the student roster under the same address) — `email` is globally
      // unique on `User`, so that account is reported rather than silently overwritten
      // or crashing the whole batch on a constraint violation.
      const emailTaken = await this.prisma.user.findUnique({
        where: { email: student.email },
        select: { id: true, role: true },
      });
      if (emailTaken) {
        skipped.push({
          studentId: student.id,
          name: student.name,
          email: student.email,
          reason: `Email already belongs to an existing ${emailTaken.role} account`,
        });
        continue;
      }

      const initial = this.initialPassword();
      await this.prisma.user.create({
        data: {
          email: student.email,
          name: student.name,
          role: 'STUDENT',
          // Hashed per account: a shared plaintext still produces 250 distinct hashes,
          // because bcrypt salts each one independently.
          passwordHash: await this.auth.hashPassword(initial.password),
          studentId: student.id,
          // Left null on purpose. `ForcePasswordChangeGuard` reads this and refuses every
          // route but change-password until the student sets their own.
          passwordChangedAt: null,
        },
      });
      provisioned.push({
        studentId: student.id,
        name: student.name,
        email: student.email,
        tempPassword: initial.disclose ? initial.password : null,
      });
    }

    await this.audit.record({
      actorId,
      action: 'STUDENT_ACCOUNTS_PROVISIONED',
      entityType: 'User',
      summary: `Provisioned ${provisioned.length} student account(s), skipped ${skipped.length}`,
      metadata: {
        provisionedEmails: provisioned.map((p) => p.email),
        skipped,
      },
    });

    return { provisioned, skipped };
  }

  /**
   * Reset one student's password — creating their account first if they somehow don't
   * have one yet. The supported "forgot password" path end to end: a student contacts
   * their mentor/program team, who calls this from the admin console.
   */
  async resetPassword(studentId: string, actorId: string): Promise<ProvisionedAccount> {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: { id: true, name: true, email: true, status: true, user: { select: { id: true } } },
    });
    if (!student) throw new NotFoundException(`Student ${studentId} was not found`);
    if (student.status !== 'ACTIVE') {
      throw new NotFoundException(
        `${student.name} is not an active student — archived students do not get portal accounts`,
      );
    }
    if (!student.email) {
      throw new BadRequestException(
        `${student.name} has no email address on record, so there is no account to reset. ` +
          'Supply their institutional email first.',
      );
    }

    const initial = this.initialPassword();
    const passwordHash = await this.auth.hashPassword(initial.password);

    if (student.user) {
      await this.prisma.user.update({
        where: { id: student.user.id },
        data: { passwordHash, passwordChangedAt: null, isActive: true },
      });
      // A reset password should not leave old sessions alive under the new credential.
      await this.auth.revokeAllSessions(student.user.id);
    } else {
      await this.prisma.user.create({
        data: {
          email: student.email,
          name: student.name,
          role: 'STUDENT',
          passwordHash,
          studentId: student.id,
          passwordChangedAt: null,
        },
      });
    }

    await this.audit.record({
      actorId,
      action: 'STUDENT_PASSWORD_RESET',
      entityType: 'User',
      entityId: student.user?.id,
      summary: `Reset the portal password for ${student.name} <${student.email}>`,
    });

    return {
      studentId: student.id,
      name: student.name,
      email: student.email,
      tempPassword: initial.disclose ? initial.password : null,
    };
  }

  /** Admin visibility into who has a portal login — never a password, only the fact. */
  async listAccounts(): Promise<StudentAccountRow[]> {
    const students = await this.prisma.student.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        email: true,
        batch: { select: { code: true } },
        user: { select: { isActive: true, lastLoginAt: true } },
      },
      orderBy: { name: 'asc' },
    });

    return students.map((s) => ({
      studentId: s.id,
      name: s.name,
      email: s.email,
      batchCode: s.batch?.code ?? null,
      hasAccount: s.user !== null,
      isActive: s.user?.isActive ?? null,
      lastLoginAt: s.user?.lastLoginAt?.toISOString() ?? null,
    }));
  }
}
