/**
 * `RolesGuard` — the backend enforcement point for §5/§19 of the student portal brief.
 *
 * The property worth protecting: a route with no `@Roles(...)` decorator is reachable by
 * every role that predates STUDENT (unchanged, so no existing admin/mentor endpoint
 * breaks) but closed to STUDENT by default (new — so a future endpoint that forgets to
 * exclude students fails closed, not open). ADMIN bypasses everything, always.
 */

import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { RolesGuard } from './roles.guard';
import { IS_PUBLIC_KEY, ROLES_KEY, type RequestUser } from '../decorators';

function makeContext(options: {
  user?: RequestUser;
  roles?: string[];
  isPublic?: boolean;
}) {
  const metadata = new Map<string, unknown>([
    [ROLES_KEY, options.roles],
    [IS_PUBLIC_KEY, options.isPublic],
  ]);

  const reflector = {
    getAllAndOverride: vi.fn((key: string) => metadata.get(key)),
  };

  const request = { user: options.user };
  const context = {
    getHandler: () => ({ name: 'handler' }),
    getClass: () => ({ name: 'TestController' }),
    switchToHttp: () => ({ getRequest: () => request }),
  };

  const guard = new RolesGuard(reflector as never);
  return { guard, context: context as never };
}

const ADMIN: RequestUser = { id: 'u1', email: 'admin@kalvium.com', name: 'Admin', role: 'ADMIN', studentId: null, mustChangePassword: false };
const MENTOR: RequestUser = { id: 'u2', email: 'mentor@kalvium.com', name: 'Mentor', role: 'MENTOR', studentId: null, mustChangePassword: false };
const VIEWER: RequestUser = { id: 'u3', email: 'viewer@kalvium.com', name: 'Viewer', role: 'VIEWER', studentId: null, mustChangePassword: false };
const STUDENT: RequestUser = {
  id: 'u4',
  email: 'student@kalvium.community',
  name: 'Student',
  role: 'STUDENT',
  studentId: 's1',
  mustChangePassword: false,
};

describe('RolesGuard — public routes', () => {
  it('never inspects the user for a @Public() route', () => {
    const { guard, context } = makeContext({ isPublic: true }); // no `user` on the request at all
    expect(guard.canActivate(context)).toBe(true);
  });
});

describe('RolesGuard — unauthenticated', () => {
  it('rejects a non-public route with no user on the request', () => {
    const { guard, context } = makeContext({});
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});

describe('RolesGuard — ADMIN', () => {
  it('bypasses an explicit role requirement it does not satisfy', () => {
    const { guard, context } = makeContext({ user: ADMIN, roles: ['STUDENT'] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('bypasses a route with no roles at all', () => {
    const { guard, context } = makeContext({ user: ADMIN });
    expect(guard.canActivate(context)).toBe(true);
  });
});

describe('RolesGuard — explicit @Roles(...)', () => {
  it('allows a role that is listed', () => {
    const { guard, context } = makeContext({ user: MENTOR, roles: ['ADMIN', 'MENTOR'] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies a role that is not listed', () => {
    const { guard, context } = makeContext({ user: VIEWER, roles: ['ADMIN', 'MENTOR'] });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('allows STUDENT when explicitly listed', () => {
    const { guard, context } = makeContext({ user: STUDENT, roles: ['STUDENT'] });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies STUDENT when the list names other roles', () => {
    const { guard, context } = makeContext({ user: STUDENT, roles: ['MENTOR'] });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});

describe('RolesGuard — no @Roles(...) at all (the default)', () => {
  it('allows MENTOR — unchanged pre-existing behaviour', () => {
    const { guard, context } = makeContext({ user: MENTOR });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows VIEWER — unchanged pre-existing behaviour', () => {
    const { guard, context } = makeContext({ user: VIEWER });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('denies STUDENT — the one role whose default flips to closed', () => {
    const { guard, context } = makeContext({ user: STUDENT });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('denying STUDENT never touches the database — it is a pure metadata check', () => {
    // No prisma mock is passed to the guard's constructor at all; if the guard tried to
    // read from a database it would throw a very different, non-ForbiddenException error.
    const { guard, context } = makeContext({ user: STUDENT });
    expect(() => guard.canActivate(context)).toThrow('This action is not available to students.');
  });
});
