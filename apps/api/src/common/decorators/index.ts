/** Route metadata decorators used by the guards and the audit interceptor. */

import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@dsa/shared';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const AUDIT_KEY = 'audit';
export const ALLOWS_UNCHANGED_PASSWORD_KEY = 'allowsUnchangedPassword';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is enabled globally and opted *out* of here, rather than opted into
 * per route — forgetting a decorator then fails closed (a locked endpoint) instead of
 * open (an exposed one).
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route to the listed roles. ADMIN is granted everything implicitly. */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Marks a route as reachable by a user who has not yet changed their initial password.
 *
 * Opt *out*, like `@Public()`: a route nobody remembered to annotate is closed to an
 * account still on its handed-over password, which is the direction that fails safe. Only
 * the handful of routes needed to *complete* the change belong here — reading your own
 * identity, changing the password, refreshing, and logging out.
 */
export const AllowsUnchangedPassword = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOWS_UNCHANGED_PASSWORD_KEY, true);

export interface AuditMetadata {
  action: string;
  entityType: string;
}

/** Records a durable audit-log entry when the route succeeds. */
export const Audit = (action: string, entityType: string): MethodDecorator =>
  SetMetadata(AUDIT_KEY, { action, entityType } satisfies AuditMetadata);

export interface RequestUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** Non-null only for `role: 'STUDENT'` — set from the DB on every request, never from
   *  client input. Every student-portal route derives identity from this, not a param. */
  studentId: string | null;
  /**
   * True while the account is still on the password it was handed. Read from the database
   * on every request rather than carried in the token, so completing the change takes
   * effect immediately instead of whenever the access token happens to expire.
   */
  mustChangePassword: boolean;
}

/** Injects the authenticated user, or a single property of it. */
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext): RequestUser | unknown => {
    const request = ctx.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
