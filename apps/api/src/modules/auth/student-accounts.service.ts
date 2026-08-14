/**
 * Admin-driven provisioning of student portal logins.
 *
 * This is "Option C" from the brief: an admin creates or resets a student's account and
 * hands them a temporary password out of band (in person, over the program's existing
 * comms channel — never email, since `EMAIL_PROVIDER` may not even be configured). The
 * student is expected to change it on first use; `User.passwordChangedAt` staying null is
 * how the frontend knows to prompt for that.
 *
 * What this deliberately does NOT do:
 *  - No common/shared password across students.
 *  - No predictable password (email, name, student id) — every password is drawn from a
 *    CSPRNG, never `Math.random`.
 *  - No plaintext password ever written to a table, a log line, or the audit log. It
 *    exists only in the return value of the call that generated it, once.
 *  - No account for anyone who is not currently `ACTIVE` on the roster — an archived
 *    student is exactly who this system must keep out (§25).
 */

import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuthService } from './auth.service';
import { AuditService } from '../audit/audit.service';
import { generateTempPassword } from './password-generator';

export interface ProvisionedAccount {
  studentId: string;
  name: string;
  email: string;
  tempPassword: string;
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
  email: string;
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
  ) {}

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

      const tempPassword = generateTempPassword();
      await this.prisma.user.create({
        data: {
          email: student.email,
          name: student.name,
          role: 'STUDENT',
          passwordHash: await this.auth.hashPassword(tempPassword),
          studentId: student.id,
          // Left null on purpose — the frontend reads `mustChangePassword` from this.
          passwordChangedAt: null,
        },
      });
      provisioned.push({
        studentId: student.id,
        name: student.name,
        email: student.email,
        tempPassword,
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

    const tempPassword = generateTempPassword();
    const passwordHash = await this.auth.hashPassword(tempPassword);

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

    return { studentId: student.id, name: student.name, email: student.email, tempPassword };
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
