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

import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '../../common/decorators';
import { CronSecretGuard } from '../../common/guards/cron-secret.guard';
import { CronTasksService } from './cron-tasks.service';

@ApiExcludeController()
@Public()
@UseGuards(CronSecretGuard)
@Controller('internal')
export class InternalController {
  constructor(private readonly tasks: CronTasksService) {}

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
}
