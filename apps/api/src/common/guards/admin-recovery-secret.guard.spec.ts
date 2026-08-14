/**
 * `AdminRecoverySecretGuard` — mirrors `CronSecretGuard`'s contract exactly: fails
 * closed when the secret is unset, and only a byte-exact `Authorization: Bearer <secret>`
 * header gets through.
 */

import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AdminRecoverySecretGuard } from './admin-recovery-secret.guard';

function makeContext(authorization?: string) {
  const request = { headers: authorization ? { authorization } : {} };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return context as never;
}

function makeGuard(secret: string | null) {
  const config = { adminRecovery: { secret } };
  return new AdminRecoverySecretGuard(config as never);
}

describe('AdminRecoverySecretGuard — fails closed', () => {
  it('rejects every request when ADMIN_RECOVERY_SECRET is unset', () => {
    const guard = makeGuard(null);
    expect(() => guard.canActivate(makeContext('Bearer anything'))).toThrow(UnauthorizedException);
  });
});

describe('AdminRecoverySecretGuard — with a configured secret', () => {
  const SECRET = 'correct-horse-battery-staple';

  it('accepts the exact secret', () => {
    const guard = makeGuard(SECRET);
    expect(guard.canActivate(makeContext(`Bearer ${SECRET}`))).toBe(true);
  });

  it('rejects a missing Authorization header', () => {
    const guard = makeGuard(SECRET);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(UnauthorizedException);
  });

  it('rejects a header that is not a Bearer token', () => {
    const guard = makeGuard(SECRET);
    expect(() => guard.canActivate(makeContext(SECRET))).toThrow(UnauthorizedException);
  });

  it('rejects a wrong secret', () => {
    const guard = makeGuard(SECRET);
    expect(() => guard.canActivate(makeContext('Bearer wrong-secret'))).toThrow(UnauthorizedException);
  });

  it('rejects a secret that only differs in length', () => {
    const guard = makeGuard(SECRET);
    expect(() => guard.canActivate(makeContext(`Bearer ${SECRET}x`))).toThrow(UnauthorizedException);
  });
});
