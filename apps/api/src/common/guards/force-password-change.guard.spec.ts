/**
 * `ForcePasswordChangeGuard` — the reason a shared initial password is not a shared key
 * to 250 students' data.
 *
 * The property worth protecting: while `passwordChangedAt` is null, a session can reach
 * the routes that let it *finish setting up the account* and nothing else. Enforced
 * server-side, because the alternative — a modal in the frontend — stops a student who
 * follows the UI and stops nobody who calls the API directly, and the API is where the
 * data is.
 *
 * Opt-out, not opt-in: a route nobody annotated is closed to an unchanged password, so
 * forgetting the decorator on a new endpoint fails safe.
 */

import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { ForcePasswordChangeGuard } from './force-password-change.guard';
import {
  ALLOWS_UNCHANGED_PASSWORD_KEY,
  IS_PUBLIC_KEY,
  type RequestUser,
} from '../decorators';

function makeContext(options: {
  user?: RequestUser;
  allowsUnchanged?: boolean;
  isPublic?: boolean;
}) {
  const metadata = new Map<string, unknown>([
    [ALLOWS_UNCHANGED_PASSWORD_KEY, options.allowsUnchanged],
    [IS_PUBLIC_KEY, options.isPublic],
  ]);

  const reflector = { getAllAndOverride: vi.fn((key: string) => metadata.get(key)) };
  const request = { user: options.user };
  const context = {
    getHandler: () => ({ name: 'handler' }),
    getClass: () => ({ name: 'TestController' }),
    switchToHttp: () => ({ getRequest: () => request }),
  };

  return { guard: new ForcePasswordChangeGuard(reflector as never), context: context as never };
}

const base = { id: 'u1', email: 'asha@kalvium.com', name: 'Asha', studentId: 's1' };
const UNCHANGED: RequestUser = { ...base, role: 'STUDENT', mustChangePassword: true };
const CHANGED: RequestUser = { ...base, role: 'STUDENT', mustChangePassword: false };
const ADMIN_UNCHANGED: RequestUser = {
  ...base,
  role: 'ADMIN',
  studentId: null,
  mustChangePassword: true,
};

describe('ForcePasswordChangeGuard', () => {
  it('blocks an ordinary route while the initial password is unchanged', () => {
    const { guard, context } = makeContext({ user: UNCHANGED });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('reports a machine-readable code, so the client can route to the change form', () => {
    const { guard, context } = makeContext({ user: UNCHANGED });
    try {
      guard.canActivate(context);
      expect.unreachable('the guard should have thrown');
    } catch (error) {
      // Distinguishable from an ordinary permission denial: one means "you may not do
      // that", this means "finish setting up your account first".
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
  });

  it('allows the routes that exist to complete the change', () => {
    const { guard, context } = makeContext({ user: UNCHANGED, allowsUnchanged: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows everything once the password has been changed', () => {
    const { guard, context } = makeContext({ user: CHANGED });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('applies to admins too — role is not an exemption from setting a real password', () => {
    const { guard, context } = makeContext({ user: ADMIN_UNCHANGED });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('closes an undecorated route by default', () => {
    // The opt-out direction: a new endpoint that nobody remembered to annotate is
    // unreachable on an unchanged password rather than silently exempt.
    const { guard, context } = makeContext({ user: UNCHANGED, allowsUnchanged: undefined });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('ignores @Public() routes, which have no user to judge', () => {
    const { guard, context } = makeContext({ isPublic: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('defers when no user is attached — that is another guard’s rejection to make', () => {
    const { guard, context } = makeContext({});
    expect(guard.canActivate(context)).toBe(true);
  });
});
