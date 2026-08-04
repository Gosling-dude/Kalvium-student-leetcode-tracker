/**
 * Access to the active scoring formula.
 *
 * The formula lives in the database so the admin panel can change it without a
 * redeploy. It is cached in-process because it is read once per student per day during
 * a rollup — 250 students × 120 days would otherwise be 30,000 identical queries.
 * `invalidate()` is called whenever the formula changes.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';

@Injectable()
export class ScoringConfigService {
  private readonly logger = new Logger(ScoringConfigService.name);
  private cached: { config: ScoringConfig; version: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The active formula, falling back to the built-in default if none is configured. */
  async getActive(): Promise<ScoringConfig> {
    if (this.cached) return this.cached.config;

    const row = await this.prisma.scoringConfig.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    });

    if (!row) {
      this.logger.warn('No active scoring config found; using built-in defaults');
      return DEFAULT_SCORING_CONFIG;
    }

    // A malformed stored formula must not take scoring down — fall back and shout.
    const config = this.merge(row.config as Record<string, unknown>);
    this.cached = { config, version: row.version };
    return config;
  }

  async getActiveVersion(): Promise<number | null> {
    await this.getActive();
    return this.cached?.version ?? null;
  }

  async list() {
    return this.prisma.scoringConfig.findMany({ orderBy: { version: 'desc' } });
  }

  async create(name: string, config: Partial<ScoringConfig>, userId: string, activate = false) {
    const merged = this.merge(config as Record<string, unknown>);

    const created = await this.prisma.$transaction(async (tx) => {
      if (activate) {
        await tx.scoringConfig.updateMany({ where: { isActive: true }, data: { isActive: false } });
      }
      return tx.scoringConfig.create({
        data: {
          name,
          config: merged as unknown as Prisma.InputJsonValue,
          isActive: activate,
          createdById: userId,
        },
      });
    });

    this.invalidate();
    return created;
  }

  async activate(id: string) {
    const target = await this.prisma.scoringConfig.findUnique({ where: { id } });
    if (!target) throw new NotFoundException(`Scoring config ${id} was not found`);

    await this.prisma.$transaction([
      this.prisma.scoringConfig.updateMany({ where: { isActive: true }, data: { isActive: false } }),
      this.prisma.scoringConfig.update({ where: { id }, data: { isActive: true } }),
    ]);

    this.invalidate();
    return target;
  }

  invalidate(): void {
    this.cached = null;
  }

  /**
   * Merge a stored partial over the defaults.
   *
   * Merging rather than replacing means an older stored formula that predates a new
   * bonus type still loads, picking up a sensible default for the new field instead of
   * `undefined` propagating into arithmetic and producing NaN scores.
   */
  private merge(stored: Record<string, unknown> | null | undefined): ScoringConfig {
    if (!stored || typeof stored !== 'object') return DEFAULT_SCORING_CONFIG;

    const partial = stored as Partial<ScoringConfig>;
    return {
      ...DEFAULT_SCORING_CONFIG,
      ...partial,
      difficultyBonus: {
        ...DEFAULT_SCORING_CONFIG.difficultyBonus,
        ...(partial.difficultyBonus ?? {}),
      },
      earlyCompletion: Array.isArray(partial.earlyCompletion)
        ? partial.earlyCompletion
        : DEFAULT_SCORING_CONFIG.earlyCompletion,
      weeklyConsistency: Array.isArray(partial.weeklyConsistency)
        ? partial.weeklyConsistency
        : DEFAULT_SCORING_CONFIG.weeklyConsistency,
      monthlyConsistency: Array.isArray(partial.monthlyConsistency)
        ? partial.monthlyConsistency
        : DEFAULT_SCORING_CONFIG.monthlyConsistency,
    };
  }
}
