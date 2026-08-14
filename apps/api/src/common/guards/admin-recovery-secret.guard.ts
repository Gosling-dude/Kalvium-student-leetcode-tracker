import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';

/**
 * Authorizes the admin deployment-secret password-recovery endpoint with a shared
 * bearer secret, mirroring `CronSecretGuard` exactly.
 *
 * This is the fallback recovery path for when email isn't configured (or as a second,
 * independent path even when it is): whoever holds `ADMIN_RECOVERY_SECRET` — set only
 * as a platform env var, never committed — can reset an ADMIN account's password.
 * There is no user session involved; the secret itself is the credential.
 *
 * Fails closed: if `ADMIN_RECOVERY_SECRET` is unset, every request is rejected rather
 * than the endpoint being silently open.
 */
@Injectable()
export class AdminRecoverySecretGuard implements CanActivate {
  private readonly logger = new Logger(AdminRecoverySecretGuard.name);

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.adminRecovery.secret;
    if (!secret) {
      this.logger.error(
        'ADMIN_RECOVERY_SECRET is not configured; rejecting admin recovery request.',
      );
      throw new UnauthorizedException('Admin recovery is not configured.');
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const header = request.headers['authorization'];
    const provided =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!provided || !this.safeEqual(provided, secret)) {
      throw new UnauthorizedException('Invalid or missing admin recovery secret.');
    }
    return true;
  }

  /** Length-independent constant-time comparison. */
  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // Still compare against self to keep timing uniform, then fail.
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  }
}
