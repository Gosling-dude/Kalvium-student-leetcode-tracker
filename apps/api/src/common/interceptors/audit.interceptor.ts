import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tap } from 'rxjs/operators';
import type { Observable } from 'rxjs';

import { AUDIT_KEY, type AuditMetadata, type RequestUser } from '../decorators';
import { AuditService } from '../../modules/audit/audit.service';

/**
 * Writes an audit entry for routes marked with `@Audit(...)`, but only when the
 * handler actually succeeded — a rejected request changed nothing and recording it as
 * a mutation would make the log actively misleading.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.get<AuditMetadata | undefined>(AUDIT_KEY, context.getHandler());
    if (!metadata) return next.handle();

    const request = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const user = request.user;

    return next.handle().pipe(
      tap((result) => {
        const entityId =
          this.extractId(result) ??
          (typeof request.params?.id === 'string' ? request.params.id : null);

        void this.audit.record({
          actorId: user?.id ?? null,
          actorName: user?.name ?? null,
          action: metadata.action,
          entityType: metadata.entityType,
          entityId,
          summary: `${metadata.action} on ${metadata.entityType}${entityId ? ` (${entityId})` : ''}`,
          metadata: {
            method: request.method,
            path: request.url,
            // Bodies can carry passwords and tokens; record only their field names.
            bodyKeys: request.body ? Object.keys(request.body as object) : [],
          },
          ipAddress: request.ip ?? null,
          userAgent: request.get('user-agent') ?? null,
        });
      }),
    );
  }

  private extractId(result: unknown): string | null {
    if (result && typeof result === 'object' && 'id' in result) {
      const id = (result as { id: unknown }).id;
      return typeof id === 'string' ? id : null;
    }
    return null;
  }
}
