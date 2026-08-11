/**
 * Approval-gated email generation for the daily report.
 *
 * The rule this whole service exists to enforce: `sendEmail` (the only method that
 * calls the real transport) refuses to run against anything but an `APPROVED` row, and
 * nothing in this file — including the cron path in `CronTasksService` — has a way
 * around that. See docs/DAILY_EMAIL_REPORTING.md#approval-workflow.
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { defaultEmailSubject, type DayKey, type EmailReportRecord } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { EmailService } from '../../infra/email/email.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { paginate } from '../../common/dto/pagination.dto';
import { DailyReportService } from './daily-report.service';
import { buildDailyReportEmailHtml } from './email-template';
import type {
  GenerateEmailDto,
  ListEmailHistoryDto,
  PreviewEmailDto,
} from './dto/email-reports.dto';

type EmailReportWithNames = Prisma.EmailReportGetPayload<{
  include: { generatedBy: { select: { name: true } }; approvedBy: { select: { name: true } } };
}>;

@Injectable()
export class EmailReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: ProgramTimeService,
    private readonly dailyReport: DailyReportService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Renders the report for `dayKey` and saves it as a `DRAFT` email, ready to preview.
   * `userId` is `null` for system-generated drafts (the daily automation, §15) — there
   * is no human "generator" to attribute those to.
   */
  async generateDraft(
    dayKey: DayKey,
    dto: GenerateEmailDto,
    userId: string | null,
  ): Promise<EmailReportRecord> {
    if (!this.time.isValid(dayKey)) {
      throw new ConflictException(`"${dayKey}" is not a valid date (expected YYYY-MM-DD)`);
    }

    const report = await this.dailyReport.build(dayKey, dto.squadId);
    const subject = dto.subject?.trim() || defaultEmailSubject(dayKey);
    const bodyHtml = buildDailyReportEmailHtml(report);

    const row = await this.prisma.emailReport.create({
      data: {
        dayKey,
        status: 'DRAFT',
        fromEmail: dto.fromEmail,
        toRecipients: dto.toRecipients,
        ccRecipients: dto.ccRecipients ?? [],
        subject,
        bodyHtml,
        snapshot: report as unknown as Prisma.InputJsonValue,
        generatedById: userId,
      },
      include: { generatedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
    });

    return this.toRecord(row);
  }

  /**
   * Re-renders a draft/pending report with edited recipients or subject, persisting the
   * edit. Locked once a report is `APPROVED` or `SENT` — approval freezes what will (or
   * did) go out.
   */
  async previewOrEdit(dto: PreviewEmailDto): Promise<EmailReportRecord> {
    const existing = await this.mustFind(dto.emailReportId);

    if (existing.status === 'APPROVED' || existing.status === 'SENT') {
      throw new ConflictException(
        `This email is already ${existing.status.toLowerCase()} and can no longer be edited. ` +
          `Generate a new draft instead.`,
      );
    }

    const row = await this.prisma.emailReport.update({
      where: { id: existing.id },
      data: {
        ...(dto.fromEmail ? { fromEmail: dto.fromEmail } : {}),
        ...(dto.toRecipients ? { toRecipients: dto.toRecipients } : {}),
        ...(dto.ccRecipients ? { ccRecipients: dto.ccRecipients } : {}),
        ...(dto.subject ? { subject: dto.subject } : {}),
      },
      include: { generatedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
    });

    return this.toRecord(row);
  }

  /**
   * DRAFT → PENDING_APPROVAL. Used only by the daily automation (§15, §28): it flags a
   * draft as "waiting on a human" but is *not* an approval — `send` still refuses it.
   * Distinct from `approve`, which only a signed-in mentor/admin can call.
   */
  async submitForApproval(emailReportId: string): Promise<EmailReportRecord> {
    const existing = await this.mustFind(emailReportId);
    if (existing.status !== 'DRAFT') return this.toRecord(existing);

    const row = await this.prisma.emailReport.update({
      where: { id: emailReportId },
      data: { status: 'PENDING_APPROVAL' },
      include: { generatedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
    });
    return this.toRecord(row);
  }

  /** The approval gate. Moves DRAFT/PENDING_APPROVAL → APPROVED. Never sends anything. */
  async approve(emailReportId: string, userId: string): Promise<EmailReportRecord> {
    const existing = await this.mustFind(emailReportId);

    if (existing.status === 'SENT') {
      throw new ConflictException('This report has already been sent.');
    }
    if (existing.status === 'APPROVED') {
      return this.toRecord(existing);
    }

    const row = await this.prisma.emailReport.update({
      where: { id: emailReportId },
      data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() },
      include: { generatedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
    });

    return this.toRecord(row);
  }

  /**
   * The only method in the codebase that calls `EmailService.sendEmail`. Refuses
   * anything not `APPROVED` (or a `FAILED` retry of a report that *was* approved), and
   * refuses a second send for a day that already has one unless `force` is explicit.
   */
  async send(emailReportId: string, userId: string, force = false): Promise<EmailReportRecord> {
    const existing = await this.mustFind(emailReportId);

    if (existing.status === 'SENT') {
      throw new ConflictException('This report has already been sent.');
    }
    if (existing.status !== 'APPROVED' && existing.status !== 'FAILED') {
      throw new ConflictException(
        `This email must be approved before it can be sent (currently ${existing.status}).`,
      );
    }

    const priorSent = await this.prisma.emailReport.findFirst({
      where: { dayKey: existing.dayKey, status: 'SENT', id: { not: emailReportId } },
      orderBy: { sentAt: 'desc' },
    });
    if (priorSent && !force) {
      throw new ConflictException({
        message: 'This report has already been sent.',
        previousEmailReportId: priorSent.id,
        sentAt: priorSent.sentAt,
      });
    }

    try {
      const result = await this.emailService.sendEmail({
        fromEmail: existing.fromEmail,
        toRecipients: existing.toRecipients,
        ccRecipients: existing.ccRecipients,
        subject: existing.subject,
        html: existing.bodyHtml,
      });

      const row = await this.prisma.emailReport.update({
        where: { id: emailReportId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
          failedError: null,
          approvedById: existing.approvedById ?? userId,
          ...(priorSent && force ? { supersedesId: priorSent.id } : {}),
        },
        include: {
          generatedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
        },
      });
      return this.toRecord(row);
    } catch (error) {
      await this.prisma.emailReport.update({
        where: { id: emailReportId },
        data: { status: 'FAILED', failedError: (error as Error).message },
      });
      throw error;
    }
  }

  async findById(id: string): Promise<EmailReportRecord> {
    return this.toRecord(await this.mustFind(id));
  }

  async history(query: ListEmailHistoryDto) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);

    const where: Prisma.EmailReportWhereInput = {
      ...(query.dayKey ? { dayKey: query.dayKey } : {}),
      ...(query.status ? { status: query.status as Prisma.EnumEmailReportStatusFilter['equals'] } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailReport.findMany({
        where,
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          generatedBy: { select: { name: true } },
          approvedBy: { select: { name: true } },
        },
      }),
      this.prisma.emailReport.count({ where }),
    ]);

    return paginate(rows.map((r) => this.toRecord(r)), total, page, pageSize);
  }

  /** Whether `dayKey` already has a report sitting in the approval queue or sent. */
  async statusForDay(dayKey: DayKey): Promise<{ sent: EmailReportRecord | null; latest: EmailReportRecord | null }> {
    const [sent, latest] = await Promise.all([
      this.prisma.emailReport.findFirst({
        where: { dayKey, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        include: { generatedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
      }),
      this.prisma.emailReport.findFirst({
        where: { dayKey },
        orderBy: { generatedAt: 'desc' },
        include: { generatedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
      }),
    ]);
    return {
      sent: sent ? this.toRecord(sent) : null,
      latest: latest ? this.toRecord(latest) : null,
    };
  }

  private async mustFind(id: string): Promise<EmailReportWithNames> {
    const row = await this.prisma.emailReport.findUnique({
      where: { id },
      include: { generatedBy: { select: { name: true } }, approvedBy: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException(`No email report with id "${id}"`);
    return row;
  }

  private toRecord(row: EmailReportWithNames): EmailReportRecord {
    return {
      id: row.id,
      dayKey: row.dayKey,
      status: row.status,
      fromEmail: row.fromEmail,
      toRecipients: row.toRecipients,
      ccRecipients: row.ccRecipients,
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      generatedAt: row.generatedAt.toISOString(),
      generatedByName: row.generatedBy?.name ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      approvedByName: row.approvedBy?.name ?? null,
      sentAt: row.sentAt?.toISOString() ?? null,
      providerMessageId: row.providerMessageId,
      failedError: row.failedError,
      supersedesId: row.supersedesId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
