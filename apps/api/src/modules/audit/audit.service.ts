/**
 * Audit and system logging.
 *
 * Audit entries answer "who changed what" — they are a compliance and
 * accountability record, so writing one must never fail the operation it describes.
 * Every write here is best-effort and swallows its own errors.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditLogEntry, Paginated, SystemLogEntry } from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';

export interface RecordAuditInput {
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  action?: string;
  entityType?: string;
  actorId?: string;
  search?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  /** Never throws: an audit failure must not roll back the action being audited. */
  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          actorName: input.actorName ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          summary: input.summary,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to write audit entry: ${(error as Error).message}`);
    }
  }

  /** Structured application log, persisted so the admin panel can show system logs. */
  async log(
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    context: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.logging.persist) return;
    try {
      await this.prisma.systemLog.create({
        data: {
          level,
          context,
          message,
          metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to write system log: ${(error as Error).message}`);
    }
  }

  async findAuditLogs(query: AuditQuery): Promise<Paginated<AuditLogEntry>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.search
        ? {
            OR: [
              { summary: { contains: query.search, mode: 'insensitive' } },
              { actorName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginate(
      rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorName: row.actorName,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        summary: row.summary,
        metadata: row.metadata as Record<string, unknown> | null,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      query.page,
      query.pageSize,
    );
  }

  async findSystemLogs(query: {
    page: number;
    pageSize: number;
    level?: string;
    context?: string;
  }): Promise<Paginated<SystemLogEntry>> {
    const where: Prisma.SystemLogWhereInput = {
      ...(query.level ? { level: query.level as Prisma.EnumLogLevelFilter['equals'] } : {}),
      ...(query.context ? { context: { contains: query.context, mode: 'insensitive' } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.systemLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.systemLog.count({ where }),
    ]);

    return paginate(
      rows.map((row) => ({
        id: row.id,
        level: row.level,
        context: row.context,
        message: row.message,
        metadata: row.metadata as Record<string, unknown> | null,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      query.page,
      query.pageSize,
    );
  }

  /** Retention trim, invoked by the nightly rollup. */
  async pruneOlderThan(days: number): Promise<{ audit: number; system: number }> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const [audit, system] = await this.prisma.$transaction([
      this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.systemLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    ]);
    return { audit: audit.count, system: system.count };
  }
}
