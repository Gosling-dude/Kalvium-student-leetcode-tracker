/**
 * `AuthService.login` — the properties that matter for the student portal (§3, §25):
 *
 *  - An unknown email and a wrong password produce the identical generic message and
 *    status, so a login attempt cannot be used to enumerate registered emails.
 *  - A STUDENT whose linked `Student.status` is not ACTIVE is rejected with the exact
 *    copy the brief specifies, distinct from "wrong password" — this is a real account
 *    telling the truth about itself, not a credential-guessing signal.
 *  - Every other role (and an ACTIVE student) is unaffected by that check.
 */

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';

const PASSWORD = 'CorrectHorse123';

async function makeService(overrides: { studentStatus?: string | null; role?: string } = {}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);

  const baseUser = {
    id: 'user-1',
    email: 'someone@kalvium.community',
    name: 'Someone',
    role: overrides.role ?? 'STUDENT',
    passwordHash,
    isActive: true,
    avatarUrl: null,
    studentId: overrides.role === 'STUDENT' || overrides.role === undefined ? 'student-1' : null,
    passwordChangedAt: new Date(),
    student:
      overrides.studentStatus === undefined
        ? { status: 'ACTIVE' }
        : overrides.studentStatus === null
          ? null
          : { status: overrides.studentStatus },
  };

  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(baseUser),
      update: vi.fn().mockResolvedValue(baseUser),
    },
    refreshToken: {
      create: vi.fn().mockResolvedValue({}),
    },
    // A mentor's campus grants are read on every login, refresh and profile read, so
    // `AuthUser.campuses` can tell the client which campus it is looking at. No grants
    // by default: these tests are about the credential, not about access.
    mentorCampus: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

  const jwt = {
    signAsync: vi.fn().mockResolvedValue('signed.token.value'),
    decode: vi.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 900 }),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const config = { auth: { accessSecret: 'a', refreshSecret: 'b', accessTtl: '15m', refreshTtl: '7d', bcryptRounds: 4 } };

  const service = new AuthService(prisma as never, jwt as never, audit as never, config as never);
  return { service, prisma, audit, baseUser };
}

describe('AuthService.login — credential errors are indistinguishable', () => {
  it('rejects a wrong password with a generic message', async () => {
    const { service } = await makeService();
    await expect(service.login('someone@kalvium.community', 'WrongPassword1')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.login('someone@kalvium.community', 'WrongPassword1')).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('rejects an unknown email with the identical message', async () => {
    const { service, prisma } = await makeService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.login('nobody@kalvium.community', PASSWORD)).rejects.toThrow(
      'Invalid email or password',
    );
  });
});

describe('AuthService.login — archived student', () => {
  it('rejects with the exact §3 message and 403, not 401', async () => {
    const { service } = await makeService({ studentStatus: 'ARCHIVED' });
    const attempt = service.login('someone@kalvium.community', PASSWORD);
    await expect(attempt).rejects.toThrow(ForbiddenException);
    await expect(attempt).rejects.toThrow(
      'Your student account is currently inactive. Please contact your mentor/program team.',
    );
  });

  it('records an audit entry distinct from a plain failed login', async () => {
    const { service, audit } = await makeService({ studentStatus: 'ARCHIVED' });
    await service.login('someone@kalvium.community', PASSWORD).catch(() => undefined);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_BLOCKED_ARCHIVED_STUDENT' }),
    );
  });

  it('also rejects a STUDENT-role login with no linked student at all', async () => {
    const { service } = await makeService({ studentStatus: null });
    await expect(service.login('someone@kalvium.community', PASSWORD)).rejects.toThrow(ForbiddenException);
  });

  for (const status of ['INACTIVE', 'DROPPED', 'PAUSED']) {
    it(`also rejects status ${status}`, async () => {
      const { service } = await makeService({ studentStatus: status });
      await expect(service.login('someone@kalvium.community', PASSWORD)).rejects.toThrow(ForbiddenException);
    });
  }
});

describe('AuthService.login — everyone else is unaffected', () => {
  it('lets an ACTIVE student log in', async () => {
    const { service } = await makeService({ studentStatus: 'ACTIVE' });
    const result = await service.login('someone@kalvium.community', PASSWORD);
    expect(result.user.role).toBe('STUDENT');
    expect(result.user.studentId).toBe('student-1');
    expect(result.accessToken).toBeTruthy();
  });

  it('lets an ADMIN log in regardless of the (absent) student link', async () => {
    const { service } = await makeService({ role: 'ADMIN', studentStatus: null });
    const result = await service.login('someone@kalvium.community', PASSWORD);
    expect(result.user.role).toBe('ADMIN');
    expect(result.user.studentId).toBeNull();
  });

  it('lets a MENTOR log in regardless of the (absent) student link', async () => {
    const { service } = await makeService({ role: 'MENTOR', studentStatus: null });
    const result = await service.login('someone@kalvium.community', PASSWORD);
    expect(result.user.role).toBe('MENTOR');
  });
});
