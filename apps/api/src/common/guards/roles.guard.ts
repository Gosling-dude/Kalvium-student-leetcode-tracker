import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@dsa/shared';

import { ROLES_KEY, type RequestUser } from '../decorators';

/**
 * Role-based authorization.
 *
 * ADMIN implicitly satisfies every requirement — otherwise every `@Roles('MENTOR')`
 * route would need `@Roles('MENTOR', 'ADMIN')`, and the one that gets forgotten locks
 * admins out of their own system.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Authentication required');

    if (user.role === 'ADMIN') return true;
    if (required.includes(user.role)) return true;

    throw new ForbiddenException(
      `This action requires one of: ${required.join(', ')}. Your role is ${user.role}.`,
    );
  }
}
