import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@dsa/shared';

import { IS_PUBLIC_KEY, ROLES_KEY, type RequestUser } from '../decorators';

/**
 * Role-based authorization.
 *
 * ADMIN implicitly satisfies every requirement — otherwise every `@Roles('MENTOR')`
 * route would need `@Roles('MENTOR', 'ADMIN')`, and the one that gets forgotten locks
 * admins out of their own system.
 *
 * A route with no `@Roles(...)` at all is, by that same reasoning, open to every
 * *pre-existing* role (MENTOR, VIEWER) — that default predates STUDENT and changing it
 * would mean auditing and re-decorating every current admin/mentor endpoint to keep
 * working, which is exactly the kind of change the brief says not to make.
 *
 * STUDENT gets the opposite default instead of joining that list. It is the one role
 * whose entire portal is new, so there is no existing behaviour to preserve, and the
 * portal's own routes are explicitly `@Roles('STUDENT', ...)` where they should be
 * reachable. Every admin/mentor endpoint added before or after this change — decorated
 * or not — is therefore closed to STUDENT unless someone opts it in by name. Forgetting
 * a decorator fails closed for students and unchanged for everyone else.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // `@Public()` routes (login, refresh, health…) never reach `JwtStrategy`, so
    // `request.user` is never populated for them — nothing to check here either.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Authentication required');

    if (user.role === 'ADMIN') return true;

    if (required && required.length > 0) {
      if (required.includes(user.role)) return true;
      this.deny(
        user,
        context,
        `This action requires one of: ${required.join(', ')}. Your role is ${user.role}.`,
      );
    }

    // No explicit requirement: open to every role that predates STUDENT, closed to
    // STUDENT — see the class doc for why.
    if (user.role === 'STUDENT') {
      this.deny(user, context, 'This action is not available to students.');
    }

    return true;
  }

  private deny(user: RequestUser, context: ExecutionContext, message: string): never {
    // A denial is a security-relevant event worth a log line, but not a DB write on the
    // hot path of every request — the login/failed-login events already land in the
    // audit log, which is where a pattern of these would need to be investigated from.
    const handler = `${context.getClass().name}.${context.getHandler().name}`;
    this.logger.warn(
      `Access denied: ${user.role} "${user.email}" (${user.id}) → ${handler} — ${message}`,
    );
    throw new ForbiddenException(message);
  }
}
