/**
 * Create/edit an Infosys day's problem set. See the schema.prisma section banner above
 * `InfosysEnrollment` — `InfosysAssignment` has no campus/batch audience the way
 * Coding Hours' `Assignment` does, because every Infosys student is given the same
 * problems on the same day.
 */

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_TTL, extractProblemSlug, type DayKey } from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { ProviderProblemNotFoundError } from '../providers/provider.errors';
import { InfosysRollupService } from './infosys-rollup.service';
import type { CreateInfosysAssignmentDto, UpdateInfosysAssignmentDto } from './dto/infosys-assignment.dto';

@Injectable()
export class InfosysAssignmentsService {
  private readonly logger = new Logger(InfosysAssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly rollup: InfosysRollupService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
  ) {}

  private include() {
    return { problems: { include: { problem: true }, orderBy: { position: 'asc' as const } } };
  }

  async list() {
    const rows = await this.prisma.infosysAssignment.findMany({
      include: this.include(),
      orderBy: { dayKey: 'desc' },
    });
    return rows;
  }

  async get(dayKey: DayKey) {
    const row = await this.prisma.infosysAssignment.findUnique({
      where: { dayKey },
      include: this.include(),
    });
    if (!row) throw new NotFoundException(`No Infosys assignment for ${dayKey}.`);
    return row;
  }

  /**
   * Create today's, a future, or a historical Infosys assignment (§3, §4). `dayKey` is
   * whatever date the caller supplies — the questions' actual date — and it is never
   * defaulted to "today" or overwritten by when this call happens.
   */
  async create(dto: CreateInfosysAssignmentDto, userId: string | null) {
    const existing = await this.prisma.infosysAssignment.findUnique({ where: { dayKey: dto.dayKey } });
    if (existing) {
      throw new BadRequestException(
        `An Infosys assignment already exists for ${dto.dayKey}. Use the edit endpoint to change it.`,
      );
    }

    const problemIds = await this.resolveProblems(dto.problemUrls);

    const created = await this.prisma.infosysAssignment.create({
      data: {
        dayKey: dto.dayKey,
        notes: dto.notes,
        createdById: userId,
        problems: { create: problemIds.map((problemId, i) => ({ problemId, position: i + 1 })) },
      },
      include: this.include(),
    });

    await this.rollup.recomputeDay(dto.dayKey as DayKey);
    this.logger.log(`Created Infosys assignment for ${dto.dayKey} (${problemIds.length} problem(s)).`);
    return created;
  }

  /**
   * Edit an assignment's problems safely (§3): re-resolves the set, replaces the
   * `InfosysAssignmentProblem` rows, and recomputes every Infosys student's status for
   * that day so a corrected problem never leaves stale results behind it.
   */
  async update(dayKey: DayKey, dto: UpdateInfosysAssignmentDto) {
    const existing = await this.prisma.infosysAssignment.findUnique({ where: { dayKey } });
    if (!existing) throw new NotFoundException(`No Infosys assignment for ${dayKey}.`);

    if (dto.problemUrls) {
      const problemIds = await this.resolveProblems(dto.problemUrls);
      await this.prisma.$transaction([
        this.prisma.infosysAssignmentProblem.deleteMany({ where: { infosysAssignmentId: existing.id } }),
        this.prisma.infosysAssignmentProblem.createMany({
          data: problemIds.map((problemId, i) => ({
            infosysAssignmentId: existing.id,
            problemId,
            position: i + 1,
          })),
        }),
      ]);
      // Stale outcomes from the previous problem set must not survive under the new
      // one's positions — every problem-status row for this day is recomputed fresh.
      await this.prisma.infosysDailyProblemStatus.deleteMany({
        where: { infosysDailyStatus: { dayKey } },
      });
    }

    if (dto.notes !== undefined) {
      await this.prisma.infosysAssignment.update({ where: { dayKey }, data: { notes: dto.notes } });
    }

    await this.rollup.recomputeDay(dayKey);
    this.logger.log(`Updated Infosys assignment for ${dayKey}.`);
    return this.get(dayKey);
  }

  private async resolveProblems(urls: string[]): Promise<string[]> {
    const slugs = urls.map((url, index) => {
      const slug = extractProblemSlug(url);
      if (!slug) {
        throw new BadRequestException(
          `Problem ${index + 1}: could not read a slug from "${url}". ` +
            'Expected a link like https://leetcode.com/problems/two-sum/',
        );
      }
      return slug;
    });

    const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
    if (duplicates.length > 0) {
      throw new BadRequestException(
        `The same problem was assigned more than once: ${[...new Set(duplicates)].join(', ')}`,
      );
    }

    const ids: string[] = [];
    for (const slug of slugs) {
      const existingProblem = await this.prisma.problem.findUnique({ where: { titleSlug: slug } });
      if (existingProblem) {
        ids.push(existingProblem.id);
        continue;
      }

      const metadata = await this.fetchMetadata(slug);
      const created = await this.prisma.problem.upsert({
        where: { titleSlug: slug },
        create: {
          titleSlug: metadata.titleSlug,
          title: metadata.title,
          questionId: metadata.questionId,
          questionFrontendId: metadata.questionFrontendId,
          difficulty: metadata.difficulty,
          acceptanceRate: metadata.acceptanceRate,
          isPaidOnly: metadata.isPaidOnly,
          topicTags: metadata.topicTags,
          companyTags: metadata.companyTags,
          url: metadata.url,
          metadataFetchedAt: new Date(),
        },
        update: {},
      });
      ids.push(created.id);
    }
    return ids;
  }

  private async fetchMetadata(slug: string) {
    const key = `problem:meta:${slug}`;
    try {
      return await this.cache.remember(key, CACHE_TTL.problemMetadata, () =>
        this.provider.fetchProblemMetadata(slug),
      );
    } catch (error) {
      if (error instanceof ProviderProblemNotFoundError) {
        throw new BadRequestException(`No LeetCode problem exists with the slug "${slug}". Check the URL.`);
      }
      throw error;
    }
  }
}
