/**
 * The nightly report has to say when it did nothing.
 *
 * This ran in production for days and reported success every night while generating no
 * reports at all: `EMAIL_FROM` was unset, the task returned an empty list, and the
 * endpoint answered HTTP 200. The calling workflow saw a green tick. An automation that
 * silently does nothing is indistinguishable from one that works, and a status code cannot
 * tell them apart — so the outcome has to be in the payload.
 *
 * What is pinned here is the distinction, not the wording: a run that produced reports
 * reports `skipped: null`, and a run that produced none says *why* in a value a caller can
 * branch on.
 */

import { describe, expect, it, vi } from 'vitest';

import { CronTasksService } from './cron-tasks.service';

function makeTasks(options: {
  fromEmail?: string | null;
  defaultTo?: string[];
  generateThrows?: boolean;
}) {
  const config = {
    email: {
      fromEmail: options.fromEmail ?? null,
      defaultTo: options.defaultTo ?? [],
      defaultCc: [],
    },
  };

  const emailReports = {
    generateDraft: vi.fn(async () => {
      if (options.generateThrows) throw new Error('render failed');
      return { id: 'draft-1' };
    }),
    submitForApproval: vi.fn(async () => ({ id: 'draft-1', status: 'PENDING_APPROVAL' })),
  };

  const batches = {
    findAll: vi.fn(async () => [{ id: 'b1', name: 'Foundation Level', studentCount: 12 }]),
  };

  const service = new CronTasksService(
    {} as never, // sync
    {} as never, // rollup
    {} as never, // auth
    { log: vi.fn(async () => undefined) } as never,
    { yesterday: () => '2026-08-25' } as never,
    emailReports as never,
    { dispatch: vi.fn(async () => undefined) } as never,
    batches as never,
    config as never,
  );

  return { service, emailReports };
}

describe('CronTasksService.runDailyReportGeneration', () => {
  it('reports EMAIL_NOT_CONFIGURED rather than an empty success', async () => {
    const { service, emailReports } = makeTasks({ fromEmail: null });

    const result = await service.runDailyReportGeneration('2026-08-25');

    expect(result.generated).toHaveLength(0);
    expect(result.skipped).toBe('EMAIL_NOT_CONFIGURED');
    // And it did not pretend to try.
    expect(emailReports.generateDraft).not.toHaveBeenCalled();
  });

  it('treats a configured sender with no recipients as unconfigured too', async () => {
    // Half-configured is not configured: a report with nobody to send it to is not a
    // report, and answering "success" for one is the same lie in a different shape.
    const { service } = makeTasks({ fromEmail: 'reports@kalvium.com', defaultTo: [] });

    const result = await service.runDailyReportGeneration('2026-08-25');

    expect(result.skipped).toBe('EMAIL_NOT_CONFIGURED');
  });

  it('reports success only when something was actually generated', async () => {
    const { service } = makeTasks({
      fromEmail: 'reports@kalvium.com',
      defaultTo: ['mentor@kalvium.com'],
    });

    const result = await service.runDailyReportGeneration('2026-08-25');

    expect(result.generated).toHaveLength(1);
    expect(result.skipped).toBeNull();
  });

  it('leaves every generated report awaiting approval, never sent', async () => {
    // The approval gate is the point of the automation, so it is asserted here and not
    // only in the email service: this is the path that runs unattended at 19:20 UTC.
    const { service, emailReports } = makeTasks({
      fromEmail: 'reports@kalvium.com',
      defaultTo: ['mentor@kalvium.com'],
    });

    const result = await service.runDailyReportGeneration('2026-08-25');

    expect(emailReports.submitForApproval).toHaveBeenCalledWith('draft-1');
    expect(result.generated[0]).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  it('reports GENERATION_FAILED when every batch threw', async () => {
    // Individually logged, but the run as a whole did not do its job — and a caller that
    // only checks for an exception would see none.
    const { service } = makeTasks({
      fromEmail: 'reports@kalvium.com',
      defaultTo: ['mentor@kalvium.com'],
      generateThrows: true,
    });

    const result = await service.runDailyReportGeneration('2026-08-25');

    expect(result.generated).toHaveLength(0);
    expect(result.skipped).toBe('GENERATION_FAILED');
  });
});
