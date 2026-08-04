import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CACHE_TTL,
  extractProblemSlug,
  type AssignmentProblem,
  type AssignmentSummary,
  type DayKey,
  type Paginated,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { paginate } from '../../common/dto/pagination.dto';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { ProviderProblemNotFoundError } from '../providers/provider.errors';
import type { CreateAssignmentDto, UpdateAssignmentDto } from './dto/assignment.dto';

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
  ) {}

  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentSummary> {
    if (!this.time.isValid(dto.dayKey)) {
      throw new BadRequestException(`"${dto.dayKey}" is not a valid date (expected YYYY-MM-DD)`);
    }

    const existing = await this.prisma.assignment.findUnique({ where: { dayKey: dto.dayKey } });
    if (existing) {
      throw new BadRequestException(
        `An assignment already exists for ${dto.dayKey}. Update it instead of creating a second one.`,
      );
    }

    const problemIds = await this.resolveProblems(dto.problemUrls);

    const assignment = await this.prisma.assignment.create({
      data: {
        dayKey: dto.dayKey,
        title: dto.title ?? null,
        topic: dto.topic ?? null,
        notes: dto.notes ?? null,
        difficulty: dto.difficulty ?? null,
        createdById: userId,
        problems: {
          create: problemIds.map((problemId, index) => ({ problemId, position: index + 1 })),
        },
      },
      include: this.include(),
    });

    await this.invalidate(dto.dayKey);
    return this.toSummary(assignment);
  }

  async update(id: string, dto: UpdateAssignmentDto): Promise<AssignmentSummary> {
    const existing = await this.prisma.assignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Assignment ${id} was not found`);

    // Replacing the problem list is a delete-then-recreate rather than a diff: the
    // positions must stay contiguous, and a partial update could leave a gap.
    const problemIds = dto.problemUrls ? await this.resolveProblems(dto.problemUrls) : null;

    const assignment = await this.prisma.$transaction(async (tx) => {
      if (problemIds) {
        await tx.assignmentProblem.deleteMany({ where: { assignmentId: id } });
        await tx.assignmentProblem.createMany({
          data: problemIds.map((problemId, index) => ({
            assignmentId: id,
            problemId,
            position: index + 1,
          })),
        });
      }

      return tx.assignment.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.topic !== undefined ? { topic: dto.topic } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.difficulty !== undefined ? { difficulty: dto.difficulty } : {}),
          ...(dto.isPublished !== undefined ? { isPublished: dto.isPublished } : {}),
        },
        include: this.include(),
      });
    });

    await this.invalidate(existing.dayKey);
    return this.toSummary(assignment);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.assignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Assignment ${id} was not found`);
    await this.prisma.assignment.delete({ where: { id } });
    await this.invalidate(existing.dayKey);
  }

  async findByDay(dayKey: DayKey): Promise<AssignmentSummary | null> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { dayKey },
      include: this.include(),
    });
    return assignment ? this.toSummary(assignment) : null;
  }

  async findToday(): Promise<AssignmentSummary | null> {
    return this.findByDay(this.time.today());
  }

  async findAll(query: {
    page: number;
    pageSize: number;
    from?: string;
    to?: string;
    search?: string;
  }): Promise<Paginated<AssignmentSummary>> {
    const where = {
      ...(query.from || query.to
        ? { dayKey: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { topic: { contains: query.search, mode: 'insensitive' as const } },
              { title: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.assignment.findMany({
        where,
        include: this.include(),
        orderBy: { dayKey: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.assignment.count({ where }),
    ]);

    return paginate(rows.map((row) => this.toSummary(row)), total, query.page, query.pageSize);
  }

  /**
   * Preview a problem URL before the assignment is saved, so mentors see the title and
   * difficulty they are about to assign rather than discovering a typo the next day.
   */
  async previewProblem(url: string) {
    const slug = extractProblemSlug(url);
    if (!slug) {
      throw new BadRequestException(
        `Could not read a problem slug from "${url}". ` +
          'Paste a link like https://leetcode.com/problems/two-sum/',
      );
    }
    return this.fetchMetadata(slug);
  }

  // -------------------------------------------------------------------------

  /**
   * Turn pasted URLs into `Problem` rows, fetching metadata for ones we have not seen.
   *
   * Metadata is cached indefinitely-ish because titles and difficulty do not change;
   * only acceptance rate drifts, and not fast enough to matter for an assignment.
   */
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
      const existing = await this.prisma.problem.findUnique({ where: { titleSlug: slug } });
      if (existing) {
        ids.push(existing.id);
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
        throw new BadRequestException(
          `No LeetCode problem exists with the slug "${slug}". Check the URL.`,
        );
      }
      throw error;
    }
  }

  private include() {
    return {
      problems: { include: { problem: true }, orderBy: { position: 'asc' as const } },
      createdBy: { select: { name: true } },
    };
  }

  private async invalidate(dayKey: DayKey): Promise<void> {
    await Promise.all([
      this.cache.delByPrefix(`dashboard:${dayKey}`),
      this.cache.delByPrefix(`mentor:${dayKey}`),
      this.cache.delByPrefix(`leaderboard:`),
    ]);
  }

  private toSummary(assignment: {
    id: string;
    dayKey: string;
    title: string | null;
    topic: string | null;
    notes: string | null;
    difficulty: string | null;
    createdAt: Date;
    createdBy?: { name: string } | null;
    problems: {
      id: string;
      position: number;
      problem: {
        id: string;
        title: string;
        titleSlug: string;
        url: string;
        difficulty: string;
        questionFrontendId: string | null;
        acceptanceRate: number | null;
        topicTags: string[];
        companyTags: string[];
        isPaidOnly: boolean;
      };
    }[];
  }): AssignmentSummary {
    return {
      id: assignment.id,
      dayKey: assignment.dayKey,
      title: assignment.title,
      topic: assignment.topic,
      notes: assignment.notes,
      difficulty: assignment.difficulty as AssignmentSummary['difficulty'],
      createdAt: assignment.createdAt.toISOString(),
      createdByName: assignment.createdBy?.name ?? null,
      problems: assignment.problems.map(
        (link): AssignmentProblem => ({
          id: link.id,
          position: link.position,
          problemId: link.problem.id,
          title: link.problem.title,
          titleSlug: link.problem.titleSlug,
          url: link.problem.url,
          difficulty: link.problem.difficulty as AssignmentProblem['difficulty'],
          questionFrontendId: link.problem.questionFrontendId,
          acceptanceRate: link.problem.acceptanceRate,
          topicTags: link.problem.topicTags,
          companyTags: link.problem.companyTags,
          isPaidOnly: link.problem.isPaidOnly,
        }),
      ),
    };
  }
}
