import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  ALLOWS_UNCHANGED_PASSWORD_KEY,
  IS_PUBLIC_KEY,
  type RequestUser,
} from '../decorators';

/**
 * Blocks an account that is still on the password it was handed.
 *
 * The forced password change has to live here rather than in the frontend. Hiding the
 * portal behind a modal stops a student who follows the UI; it stops nobody who calls the
 * API directly, and the API is where the data is. That gap is tolerable while every
 * initial password is a per-student random string. It stops being tolerable the moment
 * `SEED_STUDENT_PASSWORD` is set: one value plus a roster of email addresses would then be
 * enough to read any student's portal, and the roster is not a secret.
 *
 * So the rule is enforced where it can actually be relied on. Until `passwordChangedAt` is
 * set, a session can read its own identity, change its password, refresh and log out —
 * nothing else. Which means a shared initial password grants exactly one thing: the
 * ability to choose a real one.
 *
 * Registered globally after `RolesGuard`, and opted out of per route with
 * `@AllowsUnchangedPassword()`.
 */
@Injectable()
export class ForcePasswordChangeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOWS_UNCHANGED_PASSWORD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;

    const request = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const user = request.user;

    // No user means some earlier guard already rejected this, or the route is
    // unauthenticated by another mechanism. Not this guard's decision to make.
    if (!user) return true;
    if (!user.mustChangePassword) return true;

    // A machine-readable code, because the frontend has to tell this apart from an
    // ordinary permission denial: one means "you may not do that", the other means
    // "finish setting up your account first" and should route to the change-password
    // screen rather than show an error.
    throw new ForbiddenException({
      code: 'PASSWORD_CHANGE_REQUIRED',
      message: 'Please change your password before continuing.',
    });
  }
}
