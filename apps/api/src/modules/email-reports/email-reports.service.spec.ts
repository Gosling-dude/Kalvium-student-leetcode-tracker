/**
 * The approval → send state machine.
 *
 * DRAFT → PENDING_APPROVAL → APPROVED → SENDING → SENT, with SENDING → FAILED on error.
 *
 * The properties worth protecting, each of which was broken or absent before:
 *  - `SENT` is written only when the provider returns a message id.
 *  - A report can be sent once; a second attempt is refused, not duplicated.
 *  - A failure yields a specific HTTP status and a human-readable reason, not a 500
 *    reading "An unexpected error occurred".
 *  - A server misconfiguration leaves the report APPROVED and retryable rather than
 *    marking it FAILED for something the report did not do wrong.
 */

import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailReportsService } from './email-reports.service';
import { EmailSendError } from '../../infra/email/email.types';

type Row = {
  id: string;
  dayKey: string;
  status: string;
  fromEmail: string;
  toRecipients: string[];
  ccRecipients: string[];
  subject: string;
  bodyHtml: string;
  approvedById: string | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  providerMessageId: string | null;
  failedError: string | null;
  supersedesId: string | null;
  generatedAt: Date;
  createdAt: Date;
  generatedBy: { name: string } | null;
  approvedBy: { name: string } | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'report-1',
    dayKey: '2026-08-10',
    status: 'APPROVED',
    fromEmail: 'reports@kalvium.community',
    toRecipients: ['campus@kalvium.community'],
    ccRecipients: [],
    subject: 'Daily DSA Report — 10 Aug',
    bodyHtml: '<p>the exact body shown in the preview</p>',
    approvedById: 'user-1',
    approvedAt: new Date('2026-08-11T04:00:00Z'),
    sentAt: null,
    providerMessageId: null,
    failedError: null,
    supersedesId: null,
    generatedAt: new Date('2026-08-11T03:00:00Z'),
    createdAt: new Date('2026-08-11T03:00:00Z'),
    generatedBy: { name: 'Automation' },
    approvedBy: { name: 'Mentor' },
    ...overrides,
  } as Row;
}

/**
 * In-memory stand-in for the one table this service writes. Modelling `updateMany`'s
 * conditional semantics faithfully is the point — that is what makes the duplicate-send
 * claim real rather than decorative.
 */
function makePrisma(initial: Row) {
  const state = { current: { ...initial }, priorSent: null as Row | null };

  return {
    state,
    emailReport: {
      findUnique: vi.fn(async () => ({ ...state.current })),
      findFirst: vi.fn(async ({ where }: { where: { status?: string } }) =>
        where.status === 'SENT' && state.priorSent ? { ...state.priorSent } : null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status?: { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          const allowed = where.status?.in ?? [];
          if (allowed.length > 0 && !allowed.includes(state.current.status)) {
            return { count: 0 };
          }
          Object.assign(state.current, data);
          return { count: 1 };
        },
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.current, data);
        return { ...state.current };
      }),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>, email: Record<string, unknown>) {
  return new EmailReportsService(
    prisma as never,
    { isValid: () => true } as never,
    {} as never,
    email as never,
  );
}

const workingProvider = () => ({
  providerName: 'resend',
  configurationProblem: vi.fn(() => null),
  sendEmail: vi.fn(async () => ({ providerMessageId: 'msg_ok_1' })),
});

describe('send — the happy path', () => {
  it('reaches SENT only after the provider returns a message id', async () => {
    const prisma = makePrisma(row());
    const email = workingProvider();
    const service = makeService(prisma, email);

    const result = await service.send('report-1', 'user-1');

    expect(result.status).toBe('SENT');
    expect(result.providerMessageId).toBe('msg_ok_1');
    expect(prisma.state.current.sentAt).toBeInstanceOf(Date);
    expect(prisma.state.current.failedError).toBeNull();
  });

  it('claims the report as SENDING before contacting the provider', async () => {
    const prisma = makePrisma(row());
    const order: string[] = [];
    prisma.emailReport.updateMany.mockImplementation(async ({ data }: never) => {
      order.push(`db:${(data as { status: string }).status}`);
      Object.assign(prisma.state.current, data as object);
      return { count: 1 };
    });
    const email = {
      ...workingProvider(),
      sendEmail: vi.fn(async () => {
        order.push('provider:send');
        return { providerMessageId: 'msg_ok_1' };
      }),
    };

    await makeService(prisma, email).send('report-1', 'user-1');
    expect(order).toEqual(['db:SENDING', 'provider:send']);
  });

  it('sends exactly the approved recipients, subject and body', async () => {
    const prisma = makePrisma(
      row({ ccRecipients: ['head@kalvium.community'], bodyHtml: '<h1>frozen</h1>' }),
    );
    const email = workingProvider();

    await makeService(prisma, email).send('report-1', 'user-1');

    expect(email.sendEmail).toHaveBeenCalledWith({
      fromEmail: 'reports@kalvium.community',
      toRecipients: ['campus@kalvium.community'],
      ccRecipients: ['head@kalvium.community'],
      subject: 'Daily DSA Report — 10 Aug',
      html: '<h1>frozen</h1>',
    });
  });

  it('retries a FAILED report without needing re-approval', async () => {
    const prisma = makePrisma(row({ status: 'FAILED', failedError: 'previous attempt failed' }));
    const result = await makeService(prisma, workingProvider()).send('report-1', 'user-1');
    expect(result.status).toBe('SENT');
  });
});

describe('send — the approval gate', () => {
  it.each(['DRAFT', 'PENDING_APPROVAL'])('refuses to send a %s report', async (status) => {
    const prisma = makePrisma(row({ status }));
    const email = workingProvider();

    await expect(makeService(prisma, email).send('report-1', 'user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses to send an already-SENT report even with force', async () => {
    const prisma = makePrisma(row({ status: 'SENT', sentAt: new Date() }));
    const email = workingProvider();

    await expect(
      makeService(prisma, email).send('report-1', 'user-1', true),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a report already in flight', async () => {
    const prisma = makePrisma(row({ status: 'SENDING' }));
    const email = workingProvider();

    await expect(makeService(prisma, email).send('report-1', 'user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('requires force when another report for the same day was already sent', async () => {
    const prisma = makePrisma(row());
    prisma.state.priorSent = row({ id: 'report-0', status: 'SENT', sentAt: new Date() });
    const email = workingProvider();

    await expect(makeService(prisma, email).send('report-1', 'user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(email.sendEmail).not.toHaveBeenCalled();

    const forced = await makeService(prisma, email).send('report-1', 'user-1', true);
    expect(forced.status).toBe('SENT');
    expect(prisma.state.current.supersedesId).toBe('report-0');
  });

  it('lets only one of two concurrent sends reach the provider', async () => {
    const prisma = makePrisma(row());
    const email = workingProvider();
    const service = makeService(prisma, email);

    const results = await Promise.allSettled([
      service.send('report-1', 'user-1'),
      service.send('report-1', 'user-2'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('send — failures', () => {
  it('marks FAILED and returns the provider’s safe reason, not a generic 500', async () => {
    const prisma = makePrisma(row());
    const email = {
      ...workingProvider(),
      sendEmail: vi.fn(async () => {
        throw new EmailSendError('The domain is not verified.', {
          detail: {
            provider: 'resend',
            httpStatus: 403,
            providerCode: 'validation_error',
            providerMessage: 'The domain is not verified.',
          },
          safeMessage: 'Sender email is not verified.',
        });
      }),
    };

    const error = (await makeService(prisma, email)
      .send('report-1', 'user-1')
      .catch((e: unknown) => e)) as HttpException;

    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
    expect(error.getResponse()).toBe('Sender email is not verified.');

    expect(prisma.state.current.status).toBe('FAILED');
    expect(prisma.state.current.sentAt).toBeNull();
    expect(prisma.state.current.providerMessageId).toBeNull();
    // The stored reason carries the provider diagnosis for the history table.
    expect(prisma.state.current.failedError).toContain('resend 403/validation_error');
  });

  it('never records SENT when the provider throws', async () => {
    const prisma = makePrisma(row());
    const email = {
      ...workingProvider(),
      sendEmail: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    };

    await expect(makeService(prisma, email).send('report-1', 'user-1')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(prisma.state.current.status).toBe('FAILED');
    expect(prisma.state.current.sentAt).toBeNull();
  });

  it('gives a generic but useful message for an untyped failure', async () => {
    const prisma = makePrisma(row());
    const email = {
      ...workingProvider(),
      sendEmail: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    };

    const error = (await makeService(prisma, email)
      .send('report-1', 'user-1')
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getResponse()).toBe(
      'Email could not be sent. Please verify the email configuration.',
    );
  });

  it('leaves the report APPROVED when the server has no provider configured', async () => {
    const prisma = makePrisma(row());
    const email = {
      ...workingProvider(),
      configurationProblem: vi.fn(() => 'EMAIL_API_KEY is not set.'),
    };

    const error = (await makeService(prisma, email)
      .send('report-1', 'user-1')
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(String(error.getResponse())).toMatch(/EMAIL_PROVIDER/);
    // Not the report's fault — it stays approved and retryable once the server is fixed.
    expect(prisma.state.current.status).toBe('APPROVED');
    expect(email.sendEmail).not.toHaveBeenCalled();
  });
});

describe('approve and edit', () => {
  it('is idempotent when the report is already approved', async () => {
    const prisma = makePrisma(row({ status: 'APPROVED' }));
    const result = await makeService(prisma, workingProvider()).approve('report-1', 'user-2');
    expect(result.status).toBe('APPROVED');
    expect(prisma.emailReport.update).not.toHaveBeenCalled();
  });

  it.each(['SENT', 'SENDING'])('refuses to approve a %s report', async (status) => {
    const prisma = makePrisma(row({ status }));
    await expect(
      makeService(prisma, workingProvider()).approve('report-1', 'user-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['APPROVED', 'SENDING', 'SENT'])(
    'refuses to edit a %s report so the approved content stays frozen',
    async (status) => {
      const prisma = makePrisma(row({ status }));
      await expect(
        makeService(prisma, workingProvider()).previewOrEdit({
          emailReportId: 'report-1',
          subject: 'tampered',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );

  it('allows editing a draft', async () => {
    const prisma = makePrisma(row({ status: 'DRAFT' }));
    const result = await makeService(prisma, workingProvider()).previewOrEdit({
      emailReportId: 'report-1',
      subject: 'Edited subject',
    });
    expect(result.status).toBe('DRAFT');
    expect(prisma.emailReport.update).toHaveBeenCalled();
  });
});
