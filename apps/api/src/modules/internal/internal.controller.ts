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
  BadRequestException,
  Logger,
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
import { StudentImportService } from '../students/student-import.service';
import { CampusesService } from '../campuses/campuses.service';

@ApiExcludeController()
@Public()
@UseGuards(CronSecretGuard)
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    private readonly tasks: CronTasksService,
    private readonly integrity: IntegrityService,
    private readonly importer: StudentImportService,
    private readonly campuses: CampusesService,
  ) {}

  /**
   * Import a roster supplied as JSON.
   *
   * Exists because the roster cannot travel through the repository: this repository is
   * public and a roster holds students' names, emails and handles. It is kept in a
   * repository *secret* and posted here by a workflow, so the data reaches production
   * without ever being committed.
   *
   * Behind `CronSecretGuard` like the other internal endpoints. It reuses
   * `StudentImportService.importRows`, so it inherits every rule the spreadsheet path has —
   * validation, in-sheet duplicate detection, placement history, idempotent matching — and
   * cannot drift from it.
   *
   * `dryRun` reports exactly what would change and writes nothing. Always run it first.
   */
  @Post('import-roster')
  @HttpCode(200)
  async importRoster(
    @Body()
    body: {
      campusCode?: string;
      /**
       * Creates the campus when it does not exist yet. Required for that to happen — a
       * code alone never creates one, because a typo in a code would otherwise split a
       * cohort across a real campus and a phantom one that looks just like it.
       */
      campusName?: string;
      dryRun?: boolean;
      updateExisting?: boolean;
      rows?: {
        name?: string;
        email?: string;
        squad?: string;
        batch?: string;
        leetcode?: string;
        registerNumber?: string;
        phone?: string;
      }[];
    },
  ) {
    const rows = body?.rows ?? [];
    if (rows.length === 0) {
      throw new BadRequestException('No rows supplied.');
    }

    let campusId: string | undefined;
    if (body.campusCode) {
      const existing = await this.campuses.findByCode(body.campusCode);
      if (existing) {
        campusId = existing.id;
      } else if (body.campusName) {
        // Naming it is the confirmation. A roster for an institution the system has never
        // seen is a normal thing to onboard, but filing those students under an existing
        // campus instead would be actively harmful: that campus's reports would include
        // students who are not its own, and its mentors would gain access to them.
        const created = await this.campuses.create({
          name: body.campusName,
          code: body.campusCode,
        });
        campusId = created.id;
        this.logger.log(`Created campus ${created.code} ("${created.name}") for a roster import`);
      } else {
        throw new BadRequestException(
          `No campus with code "${body.campusCode}". Pass campusName to create it, or use ` +
            'an existing code.',
        );
      }
    }

    // Row numbers are 1-based and count the header, matching the spreadsheet path so an
    // error message means the same thing whichever way the roster arrived.
    const parsed = rows.map((row, index) =>
      this.importer.toParsedRow(
        {
          name: row.name ?? '',
          email: row.email ?? '',
          squad: row.squad ?? '',
          batch: row.batch ?? '',
          leetcode: row.leetcode ?? '',
          registerNumber: row.registerNumber ?? '',
          phone: row.phone ?? '',
        },
        index + 2,
      ),
    );

    return this.importer.importRows(parsed, {
      dryRun: body.dryRun ?? false,
      updateExisting: body.updateExisting ?? true,
      campusId,
    });
  }

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
