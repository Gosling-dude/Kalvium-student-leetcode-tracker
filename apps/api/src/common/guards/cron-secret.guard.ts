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
 * Authorizes the internal cron endpoints with a shared bearer secret.
 *
 * These endpoints replace the in-process scheduler: an external caller (GitHub Actions)
 * triggers sync and rollup over HTTP, so they cannot rely on a user session. Access is
 * gated by `Authorization: Bearer <CRON_SECRET>`, compared in constant time.
 *
 * Fails closed: if `CRON_SECRET` is unset, every request is rejected rather than the
 * endpoints being silently open.
 */
@Injectable()
export class CronSecretGuard implements CanActivate {
  private readonly logger = new Logger(CronSecretGuard.name);

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.config.cron.secret;
    if (!secret) {
      this.logger.error('CRON_SECRET is not configured; rejecting internal request.');
      throw new UnauthorizedException('Internal endpoints are not configured.');
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const header = request.headers['authorization'];
    const provided =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!provided || !this.safeEqual(provided, secret)) {
      throw new UnauthorizedException('Invalid or missing cron secret.');
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
