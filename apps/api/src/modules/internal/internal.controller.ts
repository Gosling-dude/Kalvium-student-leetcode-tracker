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

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
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
    const result = await this.tasks.runDailyReportGeneration(body?.dayKey);

    if (result.skipped === null) {
      return {
        ok: true,
        ran: true,
        generated: result.generated.length,
        emailReports: result.generated,
      };
    }

    // `ok: false` with a 200 body would be a contradiction the calling workflow has to
    // parse to notice. A nightly automation that generated nothing has failed, so it
    // answers like a failure — the Action's retry/alert path is the whole reason this
    // endpoint reports a real outcome instead of a fire-and-forget 202.
    const reason =
      result.skipped === 'EMAIL_NOT_CONFIGURED'
        ? 'No reports were generated: EMAIL_FROM and/or EMAIL_DEFAULT_TO are not configured on the server.'
        : 'No reports were generated: every batch failed. See the server log and audit entries.';

    // `message` rather than a custom key, so the reason reaches the client: the exception
    // filter renders `message` and would otherwise print "Service Unavailable Exception"
    // over a diagnosis the operator needs.
    throw new ServiceUnavailableException({
      ok: false,
      ran: false,
      code: result.skipped,
      message: reason,
    });
  }
}
