/**
 * `StudentAccountsService` — provisioning is the one place a student's login is created,
 * so the properties worth protecting are all about *who* gets an account and *what* the
 * password looks like (§22, §28):
 *
 *  - Only ACTIVE students are eligible — never archived, never anyone off the roster.
 *  - Every generated password satisfies the same `PasswordPolicy` a human would have to
 *    (§4): 10+ chars, upper, lower, digit — and it is never predictable (email/name).
 *  - An email collision with an existing, differently-rowed account is reported, not
 *    silently overwritten and not a crash that aborts the whole batch.
 */

import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StudentAccountsService } from './student-accounts.service';

const PASSWORD_POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/;

function makeService() {
  const prisma = {
    student: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const auth = {
    hashPassword: vi.fn(async (pw: string) => `hashed(${pw})`),
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  const service = new StudentAccountsService(prisma as never, auth as never, audit as never);
  return { service, prisma, auth, audit };
}

describe('StudentAccountsService.provisionMissingAccounts', () => {
  it('only queries ACTIVE students with no linked account', async () => {
    const { service, prisma } = makeService();
    await service.provisionMissingAccounts('admin-1');
    expect(prisma.student.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE', user: null } }),
    );
  });

  it('generates a policy-compliant, non-predictable password for each candidate', async () => {
    const { service, prisma } = makeService();
    prisma.student.findMany.mockResolvedValue([
      { id: 's1', name: 'Ada Lovelace', email: 'ada@kalvium.community' },
    ]);

    const result = await service.provisionMissingAccounts('admin-1');

    expect(result.provisioned).toHaveLength(1);
    const { tempPassword } = result.provisioned[0]!;
    expect(tempPassword).toMatch(PASSWORD_POLICY);
    expect(tempPassword.toLowerCase()).not.toContain('ada');
    expect(tempPassword).not.toBe('ada@kalvium.community');
  });

  it('creates the user row as role STUDENT, linked by studentId, with no password-changed date', async () => {
    const { service, prisma } = makeService();
    prisma.student.findMany.mockResolvedValue([
      { id: 's1', name: 'Ada Lovelace', email: 'ada@kalvium.community' },
    ]);

    await service.provisionMissingAccounts('admin-1');

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'ada@kalvium.community',
          role: 'STUDENT',
          studentId: 's1',
          passwordChangedAt: null,
        }),
      }),
    );
  });

  it('reports, rather than overwrites, a student whose email already belongs to another account', async () => {
    const { service, prisma } = makeService();
    prisma.student.findMany.mockResolvedValue([
      { id: 's1', name: 'Ada Lovelace', email: 'ada@kalvium.community' },
    ]);
    prisma.user.findUnique.mockResolvedValue({ id: 'existing-user', role: 'MENTOR' });

    const result = await service.provisionMissingAccounts('admin-1');

    expect(result.provisioned).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ studentId: 's1' });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('never writes an audit entry containing a plaintext password', async () => {
    const { service, prisma, audit } = makeService();
    prisma.student.findMany.mockResolvedValue([
      { id: 's1', name: 'Ada Lovelace', email: 'ada@kalvium.community' },
    ]);

    const result = await service.provisionMissingAccounts('admin-1');
    const auditCall = JSON.stringify(audit.record.mock.calls[0]);
    expect(auditCall).not.toContain(result.provisioned[0]!.tempPassword);
  });
});

describe('StudentAccountsService.resetPassword', () => {
  it('rejects an unknown student', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue(null);
    await expect(service.resetPassword('nope', 'admin-1')).rejects.toThrow(NotFoundException);
  });

  it('refuses to provision a password for an archived student', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue({
      id: 's1',
      name: 'Ada',
      email: 'ada@kalvium.community',
      status: 'ARCHIVED',
      user: null,
    });
    await expect(service.resetPassword('s1', 'admin-1')).rejects.toThrow(NotFoundException);
  });

  it('revokes existing sessions when resetting an already-provisioned account', async () => {
    const { service, prisma, auth } = makeService();
    prisma.student.findUnique.mockResolvedValue({
      id: 's1',
      name: 'Ada',
      email: 'ada@kalvium.community',
      status: 'ACTIVE',
      user: { id: 'user-1' },
    });

    await service.resetPassword('s1', 'admin-1');

    expect(prisma.user.update).toHaveBeenCalled();
    expect(auth.revokeAllSessions).toHaveBeenCalledWith('user-1');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates the account if a student somehow has none yet', async () => {
    const { service, prisma } = makeService();
    prisma.student.findUnique.mockResolvedValue({
      id: 's1',
      name: 'Ada',
      email: 'ada@kalvium.community',
      status: 'ACTIVE',
      user: null,
    });

    const result = await service.resetPassword('s1', 'admin-1');

    expect(prisma.user.create).toHaveBeenCalled();
    expect(result.tempPassword).toMatch(PASSWORD_POLICY);
  });
});
