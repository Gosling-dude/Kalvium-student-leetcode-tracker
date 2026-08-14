/**
 * `AdminRecoveryService` — the properties worth protecting:
 *
 *  - `requestReset` never reveals, via response or audit log, whether an email belongs
 *    to an admin account or whether email is configured (anti-enumeration).
 *  - `confirmReset` treats "unknown token", "already used" and "expired" identically.
 *  - Both reset paths are scoped to `role: 'ADMIN'` only, and both end every other
 *    session — the same rule `AuthService.changePassword` follows.
 *  - The deployment-secret path never accepts a client-supplied password.
 */

import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AdminRecoveryService } from './admin-recovery.service';

const ADMIN = { id: 'admin-1', name: 'Ada Admin', email: 'admin@kalvium.com', role: 'ADMIN' };
const MENTOR = { id: 'mentor-1', name: 'Max Mentor', email: 'mentor@kalvium.com', role: 'MENTOR' };

function makeService(overrides: { emailConfigured?: boolean } = {}) {
  const prisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    adminPasswordResetToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const auth = {
    hashPassword: vi.fn().mockResolvedValue('hashed'),
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };

  const email = {
    isConfigured: vi.fn().mockReturnValue(overrides.emailConfigured ?? true),
    sendEmail: vi.fn().mockResolvedValue({ providerMessageId: 'msg-1' }),
  };

  const config = { email: { fromEmail: 'reports@kalvium.community' } };

  const service = new AdminRecoveryService(
    prisma as never,
    auth as never,
    audit as never,
    email as never,
    config as never,
  );

  return { service, prisma, auth, audit, email };
}

describe('AdminRecoveryService.requestReset — never reveals whether it matched', () => {
  it('issues a token and emails it for an existing configured admin', async () => {
    const { service, prisma, email, audit } = makeService({ emailConfigured: true });
    prisma.user.findUnique.mockResolvedValue(ADMIN);

    await service.requestReset(ADMIN.email);

    expect(prisma.adminPasswordResetToken.create).toHaveBeenCalledOnce();
    expect(email.sendEmail).toHaveBeenCalledOnce();
    expect(email.sendEmail.mock.calls[0]![0].toRecipients).toEqual([ADMIN.email]);
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record.mock.calls[0]![0].action).toBe('ADMIN_RECOVERY_REQUESTED');
  });

  it('is a silent no-op for an unknown email — no token, no email, no audit entry', async () => {
    const { service, prisma, email, audit } = makeService({ emailConfigured: true });
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.requestReset('nobody@kalvium.com')).resolves.toBeUndefined();

    expect(prisma.adminPasswordResetToken.create).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is a silent no-op for a non-admin role', async () => {
    const { service, prisma, email, audit } = makeService({ emailConfigured: true });
    prisma.user.findUnique.mockResolvedValue(MENTOR);

    await service.requestReset(MENTOR.email);

    expect(prisma.adminPasswordResetToken.create).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is a silent no-op when email is not configured, even for a matching admin', async () => {
    const { service, prisma, email, audit } = makeService({ emailConfigured: false });
    prisma.user.findUnique.mockResolvedValue(ADMIN);

    await service.requestReset(ADMIN.email);

    expect(prisma.adminPasswordResetToken.create).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('invalidates any prior outstanding token before issuing a new one', async () => {
    const { service, prisma } = makeService({ emailConfigured: true });
    prisma.user.findUnique.mockResolvedValue(ADMIN);

    await service.requestReset(ADMIN.email);

    expect(prisma.adminPasswordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: ADMIN.id, usedAt: null } }),
    );
  });
});

describe('AdminRecoveryService.confirmReset', () => {
  const VALID_PASSWORD = 'BrandNewPassw0rd';

  function withStoredToken(prisma: ReturnType<typeof makeService>['prisma'], overrides: Record<string, unknown> = {}) {
    prisma.adminPasswordResetToken.findUnique.mockResolvedValue({
      id: 'token-1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: ADMIN,
      ...overrides,
    });
  }

  it('resets the password, revokes sessions, marks the token used, and audits on success', async () => {
    const { service, prisma, auth, audit } = makeService();
    withStoredToken(prisma);

    await service.confirmReset('raw-token', VALID_PASSWORD);

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ADMIN.id } }),
    );
    expect(prisma.adminPasswordResetToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'token-1' }, data: expect.objectContaining({ usedAt: expect.any(Date) }) }),
    );
    expect(auth.revokeAllSessions).toHaveBeenCalledWith(ADMIN.id);
    expect(audit.record.mock.calls[0]![0].action).toBe('ADMIN_PASSWORD_RESET_EMAIL');
  });

  it('rejects an unknown token with a generic error', async () => {
    const { service, prisma } = makeService();
    prisma.adminPasswordResetToken.findUnique.mockResolvedValue(null);

    await expect(service.confirmReset('nope', VALID_PASSWORD)).rejects.toThrow(UnauthorizedException);
    await expect(service.confirmReset('nope', VALID_PASSWORD)).rejects.toThrow('Invalid or expired reset token');
  });

  it('rejects an already-used token with the identical generic error', async () => {
    const { service, prisma } = makeService();
    withStoredToken(prisma, { usedAt: new Date() });

    await expect(service.confirmReset('raw-token', VALID_PASSWORD)).rejects.toThrow(
      'Invalid or expired reset token',
    );
  });

  it('rejects an expired token with the identical generic error', async () => {
    const { service, prisma } = makeService();
    withStoredToken(prisma, { expiresAt: new Date(Date.now() - 1000) });

    await expect(service.confirmReset('raw-token', VALID_PASSWORD)).rejects.toThrow(
      'Invalid or expired reset token',
    );
  });

  it('cannot be redeemed twice with the same token', async () => {
    const { service, prisma } = makeService();
    withStoredToken(prisma);

    await service.confirmReset('raw-token', VALID_PASSWORD);

    // The second call sees the token as already consumed.
    prisma.adminPasswordResetToken.findUnique.mockResolvedValue({
      id: 'token-1',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: ADMIN,
    });
    await expect(service.confirmReset('raw-token', VALID_PASSWORD)).rejects.toThrow(
      'Invalid or expired reset token',
    );
  });
});

describe('AdminRecoveryService.deploymentSecretReset', () => {
  it('resets the password for an existing admin and returns it once', async () => {
    const { service, prisma, auth, audit } = makeService();
    prisma.user.findUnique.mockResolvedValue(ADMIN);

    const result = await service.deploymentSecretReset(ADMIN.email);

    expect(result.email).toBe(ADMIN.email);
    expect(result.tempPassword).toMatch(/[a-z]/);
    expect(result.tempPassword).toMatch(/[A-Z]/);
    expect(result.tempPassword).toMatch(/[0-9]/);
    expect(result.tempPassword.length).toBeGreaterThanOrEqual(10);
    expect(auth.revokeAllSessions).toHaveBeenCalledWith(ADMIN.id);
    expect(audit.record.mock.calls[0]![0].action).toBe('ADMIN_PASSWORD_RESET_DEPLOYMENT_SECRET');
    expect(audit.record.mock.calls[0]![0].actorId).toBeNull();
  });

  it('rejects an unknown email as not found', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.deploymentSecretReset('nobody@kalvium.com')).rejects.toThrow(NotFoundException);
  });

  it('rejects a non-admin email as not found — this path can never touch a mentor account', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(MENTOR);

    await expect(service.deploymentSecretReset(MENTOR.email)).rejects.toThrow(NotFoundException);
  });
});
