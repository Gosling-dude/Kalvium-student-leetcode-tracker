/**
 * Approval-gated email generation for the daily report.
 *
 * The rule this whole service exists to enforce: `sendEmail` (the only method that
 * calls the real transport) refuses to run against anything but an `APPROVED` row, and
 * nothing in this file — including the cron path in `CronTasksService` — has a way
 * around that. See docs/DAILY_EMAIL_REPORTING.md#approval-workflow.
 */

import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  scopedEmailSubject,
  type DayKey,
  type EmailReportRecord,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { EmailService } from '../../infra/email/email.service';
import {
  EmailProviderNotConfiguredError,
  EmailSendError,
} from '../../infra/email/email.types';
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
  include: {
    generatedBy: { select: { name: true } };
    approvedBy: { select: { name: true } };
    batch: { select: { name: true; code: true } };
    campus: { select: { name: true; code: true } };
  };
}>;

/** The relations every returned row carries, so `toRecord` always has what it needs. */
const REPORT_INCLUDE = {
  generatedBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  batch: { select: { name: true, code: true } },
  campus: { select: { name: true, code: true } },
} as const;

@Injectable()
export class EmailReportsService {
  private readonly logger = new Logger(EmailReportsService.name);

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

    const campusId = dto.campusId ?? null;
    const batchId = dto.batchId ?? null;
    const report = await this.dailyReport.build(dayKey, {
      squadId: dto.squadId,
      campusId,
      batchId,
    });

    // The subject names the campus and batch, so a mentor holding several pending reports
    // for the same day can tell them apart before opening any (§13, §33).
    const subject =
      dto.subject?.trim() ||
      scopedEmailSubject(dayKey, report.summary.campusName, report.summary.batchName);
    const bodyHtml = buildDailyReportEmailHtml(report);

    const row = await this.prisma.emailReport.create({
      data: {
        dayKey,
        campusId,
        batchId,
        status: 'DRAFT',
        fromEmail: dto.fromEmail,
        toRecipients: dto.toRecipients,
        ccRecipients: dto.ccRecipients ?? [],
        subject,
        bodyHtml,
        snapshot: report as unknown as Prisma.InputJsonValue,
        generatedById: userId,
      },
      include: REPORT_INCLUDE,
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

    // Approval freezes the content: what a mentor approved must be what goes out, and
    // once it is in flight or delivered, editing it would falsify the history record.
    if (
      existing.status === 'APPROVED' ||
      existing.status === 'SENDING' ||
      existing.status === 'SENT'
    ) {
      throw new ConflictException(
        `This email is already ${existing.status.toLowerCase().replace('_', ' ')} and can no ` +
          `longer be edited. Generate a new draft instead.`,
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
      include: REPORT_INCLUDE,
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
      include: REPORT_INCLUDE,
    });
    return this.toRecord(row);
  }

  /** The approval gate. Moves DRAFT/PENDING_APPROVAL → APPROVED. Never sends anything. */
  async approve(emailReportId: string, userId: string): Promise<EmailReportRecord> {
    const existing = await this.mustFind(emailReportId);

    if (existing.status === 'SENT') {
      throw new ConflictException('This report has already been sent.');
    }
    if (existing.status === 'SENDING') {
      throw new ConflictException('This report is already being sent.');
    }
    // Idempotent: clicking Approve twice is not an error, and the frontend's
    // "Approve & Send" relies on being able to re-approve a retried FAILED report.
    if (existing.status === 'APPROVED') {
      return this.toRecord(existing);
    }

    const row = await this.prisma.emailReport.update({
      where: { id: emailReportId },
      data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() },
      include: REPORT_INCLUDE,
    });

    return this.toRecord(row);
  }

  /**
   * The only method in the codebase that calls `EmailService.sendEmail`.
   *
   * Walks APPROVED → SENDING → SENT, or SENDING → FAILED. Three properties matter:
   *
   *  - **The provider decides `SENT`.** The row is marked sent only after the transport
   *    returns a message id. A throw anywhere leaves FAILED with the reason recorded.
   *  - **Exactly one send per report.** The APPROVED → SENDING transition is a
   *    conditional `updateMany`; a second concurrent click matches zero rows and is
   *    rejected instead of producing a duplicate email.
   *  - **Failures are explained.** Provider, HTTP status, provider code and the report
   *    id go to the server log; the client gets `safeMessage`, which never contains a
   *    key or a raw provider echo.
   */
  async send(emailReportId: string, userId: string, force = false): Promise<EmailReportRecord> {
    const existing = await this.mustFind(emailReportId);

    if (existing.status === 'SENT') {
      throw new ConflictException({
        message:
          'This report has already been sent. Generate a new draft if you need to send it again.',
        emailReportId: existing.id,
        sentAt: existing.sentAt,
      });
    }
    if (existing.status === 'SENDING') {
      throw new ConflictException(
        'This report is already being sent. Refresh in a moment to see the result.',
      );
    }
    if (existing.status !== 'APPROVED' && existing.status !== 'FAILED') {
      throw new ConflictException(
        `This email must be approved before it can be sent (currently ${existing.status}).`,
      );
    }

    // A different report already went out for *this day and this batch*. Resending is
    // legitimate but has to be deliberate, so it needs `force` — the UI turns this into
    // a confirm step.
    //
    // Scoped to the campus *and* batch on purpose: sending SRM's Foundation report must
    // not look like a duplicate when Vels' Foundation report for the same day goes out
    // afterwards. They are different reports about different students (§13, §33).
    const priorSent = await this.prisma.emailReport.findFirst({
      where: {
        dayKey: existing.dayKey,
        campusId: existing.campusId,
        batchId: existing.batchId,
        status: 'SENT',
        id: { not: emailReportId },
      },
      orderBy: { sentAt: 'desc' },
    });
    if (priorSent && !force) {
      const audience = [existing.campus?.name, existing.batch?.name].filter(Boolean).join(' — ');
      const scope = audience ? ` (${audience})` : '';
      throw new ConflictException({
        message: `A report for ${existing.dayKey}${scope} has already been sent. Confirm to send it again.`,
        previousEmailReportId: priorSent.id,
        sentAt: priorSent.sentAt,
      });
    }

    // Fail before claiming the row: a misconfigured server should leave the report
    // APPROVED and retryable, not stranded in FAILED for a reason that is not its fault.
    const configProblem = this.emailService.configurationProblem();
    if (configProblem) {
      this.logger.error(
        `Send refused for report ${emailReportId} (${existing.dayKey}): ${configProblem}`,
      );
      throw new HttpException(
        new EmailProviderNotConfiguredError().safeMessage,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    // Claim it. Only the request that flips APPROVED/FAILED → SENDING proceeds.
    const claimed = await this.prisma.emailReport.updateMany({
      where: { id: emailReportId, status: { in: ['APPROVED', 'FAILED'] } },
      data: { status: 'SENDING', failedError: null },
    });
    if (claimed.count === 0) {
      throw new ConflictException(
        'This report is already being sent or has changed state. Refresh and try again.',
      );
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
        include: REPORT_INCLUDE,
      });

      this.logger.log(
        `Email report ${emailReportId} (${existing.dayKey}) sent via ` +
          `${this.emailService.providerName}, provider message id ${result.providerMessageId}`,
      );
      return this.toRecord(row);
    } catch (error) {
      throw await this.recordFailure(emailReportId, existing.dayKey, error);
    }
  }

  /**
   * Move a claimed report to FAILED, log the diagnosis, and return the exception to
   * throw. Splitting this out keeps `send`'s happy path readable and guarantees the two
   * always agree about what gets persisted versus what gets returned.
   */
  private async recordFailure(
    emailReportId: string,
    dayKey: string,
    error: unknown,
  ): Promise<HttpException> {
    const isProviderError = error instanceof EmailSendError;
    const detail = isProviderError ? error.detail : null;

    // Server-side: everything needed to diagnose, including the provider's own words.
    this.logger.error(
      `Email send FAILED for report ${emailReportId} (${dayKey}) — ` +
        `provider=${detail?.provider ?? this.emailService.providerName} ` +
        `httpStatus=${detail?.httpStatus ?? 'n/a'} ` +
        `providerCode=${detail?.providerCode ?? 'n/a'} ` +
        `providerMessage=${detail?.providerMessage ?? (error as Error).message}`,
      error instanceof Error ? error.stack : undefined,
    );

    // Stored on the row so "View previous email" and the history table can explain it.
    // The provider's message is safe here (it is our own error text, not the API key)
    // but it is truncated so a verbose provider cannot bloat the column.
    const storedError = (
      isProviderError
        ? `[${detail?.provider}${detail?.httpStatus ? ` ${detail.httpStatus}` : ''}` +
          `${detail?.providerCode ? `/${detail.providerCode}` : ''}] ${error.message}`
        : (error as Error).message
    ).slice(0, 1000);

    await this.prisma.emailReport.update({
      where: { id: emailReportId },
      data: { status: 'FAILED', failedError: storedError },
    });

    if (error instanceof EmailProviderNotConfiguredError) {
      return new HttpException(error.safeMessage, HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (isProviderError) {
      // 502: the fault is upstream of this service, not in the caller's request.
      return new HttpException(error.safeMessage, HttpStatus.BAD_GATEWAY);
    }
    return new HttpException(
      'Email could not be sent. Please verify the email configuration.',
      HttpStatus.BAD_GATEWAY,
    );
  }

  async findById(id: string): Promise<EmailReportRecord> {
    return this.toRecord(await this.mustFind(id));
  }

  async history(query: ListEmailHistoryDto & { campusId?: string | null; batchId?: string | null }) {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);

    const where: Prisma.EmailReportWhereInput = {
      ...(query.dayKey ? { dayKey: query.dayKey } : {}),
      ...(query.campusId ? { campusId: query.campusId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.status ? { status: query.status as Prisma.EnumEmailReportStatusFilter['equals'] } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailReport.findMany({
        where,
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: REPORT_INCLUDE,
      }),
      this.prisma.emailReport.count({ where }),
    ]);

    return paginate(rows.map((r) => this.toRecord(r)), total, page, pageSize);
  }

  /**
   * Whether `dayKey` already has a report sitting in the approval queue or sent.
   *
   * Scoped to campus and batch, so the Email Reports screen shows the state of the report
   * the mentor is actually looking at rather than conflating SRM's Foundation with Vels'.
   */
  async statusForDay(
    dayKey: DayKey,
    batchId: string | null = null,
    campusId: string | null = null,
  ): Promise<{ sent: EmailReportRecord | null; latest: EmailReportRecord | null }> {
    const scope = { dayKey, campusId, batchId };
    const [sent, latest] = await Promise.all([
      this.prisma.emailReport.findFirst({
        where: { ...scope, status: 'SENT' },
        orderBy: { sentAt: 'desc' },
        include: REPORT_INCLUDE,
      }),
      this.prisma.emailReport.findFirst({
        where: scope,
        orderBy: { generatedAt: 'desc' },
        include: REPORT_INCLUDE,
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
      include: REPORT_INCLUDE,
    });
    if (!row) throw new NotFoundException(`No email report with id "${id}"`);
    return row;
  }

  private toRecord(row: EmailReportWithNames): EmailReportRecord {
    return {
      id: row.id,
      dayKey: row.dayKey,
      campusId: row.campusId,
      campusName: row.campus?.name ?? null,
      campusCode: row.campus?.code ?? null,
      batchId: row.batchId,
      batchName: row.batch?.name ?? null,
      batchCode: row.batch?.code ?? null,
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
