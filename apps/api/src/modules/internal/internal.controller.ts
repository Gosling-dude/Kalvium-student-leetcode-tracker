/**
 * Internal cron endpoints.
 *
 * These replace the platform's scheduled jobs: on the free hosting stack there is no
 * always-on scheduler, so GitHub Actions POST here on a cron schedule instead. They are
 * marked `@Public()` to bypass the user-session guard and are gated instead by
 * `CronSecretGuard` (a shared bearer secret) — see the guard for the fail-closed rules.
 *
 * The sync endpoint runs the job to completion and answers with its outcome, so the
 * calling Action sees a real success/failure rather than a fire-and-forget 202.
 */

import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../../common/decorators';
import { CronSecretGuard } from '../../common/guards/cron-secret.guard';
import { CronTasksService } from './cron-tasks.service';
import { IntegrityService } from './integrity.service';

@ApiExcludeController()
@Public()
@UseGuards(CronSecretGuard)
@Controller('internal')
export class InternalController {
  constructor(
    private readonly tasks: CronTasksService,
    private readonly integrity: IntegrityService,
  ) {}

  /**
   * Data-integrity report for the live database.
   *
   * The production smoke test asserts on this. "The deploy succeeded" and "the data is
   * correct" are different claims, and a build log can only ever demonstrate the first —
   * so the checks that matter after a release (does every student have a placement a
   * report can see, does any mentor log in to an empty system) are answered here, from
   * the database itself.
   *
   * Read-only, and behind the same `CronSecretGuard` as the cron endpoints: it reports
   * counts and no student's name, but "how many students are there" is still not public.
   */
  @Get('integrity')
  @HttpCode(200)
  integrityReport() {
    return this.integrity.report();
  }

  @Post('sync')
  @HttpCode(200)
  async sync() {
    const result = await this.tasks.runSync();
    return result
      ? { ok: true, ran: true, job: result }
      : { ok: true, ran: false, reason: 'No active students to sync.' };
  }

  @Post('rollup')
  @HttpCode(200)
  async rollup() {
    const result = await this.tasks.runNightlyRollup();
    return { ok: true, ran: true, ...result };
  }

  /**
   * Daily report automation (§28). Optionally accepts `{ dayKey }` so a manual
   * `workflow_dispatch` run (or a support script) can (re)generate a specific date
   * instead of "yesterday". Always stops at `PENDING_APPROVAL` — see
   * `CronTasksService.runDailyReportGeneration`.
   */
  @Post('daily-report')
  @HttpCode(200)
  async dailyReport(@Body() body: { dayKey?: string }) {
    // One report per active batch; an empty result means nothing could be generated.
    const reports = await this.tasks.runDailyReportGeneration(body?.dayKey);
    return reports.length > 0
      ? { ok: true, ran: true, generated: reports.length, emailReports: reports }
      : {
          ok: true,
          ran: false,
          reason:
            'No reports were generated — check that EMAIL_FROM / EMAIL_DEFAULT_TO are configured.',
        };
  }
}
