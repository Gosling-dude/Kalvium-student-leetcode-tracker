/**
 * Assignments — creating, retargeting and resolving a day's problem set for a
 * **campus + batch** audience.
 *
 * The one rule everything here serves: the same calendar date carries several independent
 * problem sets, and a student is only ever measured against the one aimed at the campus
 * and batch *they were in that day*. Vels/Foundation, Vels/Intermediate, SRM/Foundation
 * and SRM/Intermediate can all have different questions on 13 Aug without colliding, and
 * none of them can leak into another (§9).
 *
 * Audience widening follows `selectAssignmentForScope` in `@dsa/shared`, which is the
 * single definition of the three-tier resolution rule. This service never re-implements
 * it — a second copy is exactly how the daily tracker and the student portal start
 * disagreeing about what someone was assigned.
 */

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CACHE_TTL,
  describeScope,
  extractProblemSlug,
  isLegalScope,
  selectAssignmentForScope,
  type AssignmentAudienceChangeEntry,
  type AssignmentProblem,
  type AssignmentSummary,
  type AudienceScope,
  type DayKey,
  type Paginated,
} from '@dsa/shared';

import { PrismaService } from '../../infra/prisma/prisma.service';
import { CacheService } from '../../infra/cache/cache.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import { paginate } from '../../common/dto/pagination.dto';
import { CampusesService } from '../campuses/campuses.service';
import { RollupService } from '../scoring/rollup.service';
import { SUBMISSION_PROVIDER, type SubmissionProvider } from '../providers/provider.types';
import { ProviderProblemNotFoundError } from '../providers/provider.errors';
import type {
  ChangeAssignmentTargetDto,
  CreateAssignmentDto,
  UpdateAssignmentDto,
} from './dto/assignment.dto';

/** Selector values meaning "do not narrow this half of the audience". */
const ALL_TARGETS = new Set(['BOTH', 'ALL', '*']);

/**
 * How many active students a given audience currently covers.
 *
 * Built once per response from a single `groupBy`, then queried in memory. The alternative
 * — a count per assignment row — is a textbook N+1 that costs 20 queries on a 20-row
 * history page and grows with the roster (§27).
 */
class AudienceCounter {
  constructor(private readonly groups: { campusId: string | null; batchId: string | null; count: number }[]) {}

  countFor(scope: AudienceScope): number {
    let total = 0;
    for (const group of this.groups) {
      if (scope.campusId !== null && group.campusId !== scope.campusId) continue;
      if (scope.batchId !== null && group.batchId !== scope.batchId) continue;
      total += group.count;
    }
    return total;
  }
}

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly time: ProgramTimeService,
    private readonly campuses: CampusesService,
    private readonly rollup: RollupService,
    @Inject(SUBMISSION_PROVIDER) private readonly provider: SubmissionProvider,
  ) {}

  /**
   * Create a day's problem set for one or more campus + batch audiences.
   *
   * Each audience gets its own `Assignment` row even when the problems are identical.
   * Sharing one row would make "edit SRM Foundation's Wednesday" silently edit Vels', and
   * would leave `DailyStatus.assignmentId` unable to say which set a student was actually
   * measured against.
   *
   * Audience semantics, and the reason each is explicit rather than inferred:
   *
   *  * campus + batches → one row per batch, each scoped to that campus.
   *  * campus, no batches → one row for the whole campus.
   *  * no campus, no batches → **one** row targeting everyone, everywhere.
   *
   * That last case is a deliberate change from the pre-campus behaviour, which fanned an
   * empty batch list out into one row per active batch. With two campuses that fan-out
   * would have created four or six rows from a form the admin filled in once, none of
   * which they asked for. "Everyone" is now a single row that says so (§10).
   *
   * All-or-nothing: if any audience already has an assignment that day, nothing is
   * written, so a partial multi-target create can never leave one batch with work and
   * another without.
   */
  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentSummary[]> {
    if (!this.time.isValid(dto.dayKey)) {
      throw new BadRequestException(`"${dto.dayKey}" is not a valid date (expected YYYY-MM-DD)`);
    }

    const scopes = await this.resolveTargetScopes(dto.campus, dto.batches);

    const clashes = await this.prisma.assignment.findMany({
      where: { dayKey: dto.dayKey, OR: scopes.map((scope) => ({ ...scope })) },
      include: {
        batch: { select: { name: true } },
        campus: { select: { name: true } },
      },
    });
    if (clashes.length > 0) {
      const names = clashes
        .map((clash) => describeScope(clash.campus?.name ?? null, clash.batch?.name ?? null))
        .join('; ');
      throw new BadRequestException(
        `An assignment already exists for ${dto.dayKey} for: ${names}. ` +
          'Update it instead of creating a second one.',
      );
    }

    // Resolved once, outside the transaction: fetching problem metadata hits the
    // provider, which must not run inside an open database transaction.
    const problemIds = await this.resolveProblems(dto.problemUrls);

    const created = await this.prisma.$transaction(
      scopes.map((scope) =>
        this.prisma.assignment.create({
          data: {
            dayKey: dto.dayKey,
            campusId: scope.campusId,
            batchId: scope.batchId,
            // Frozen at creation — see the schema note on `originalBatchId`.
            originalCampusId: scope.campusId,
            originalBatchId: scope.batchId,
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
        }),
      ),
    );

    await this.invalidate(dto.dayKey);
    const counter = await this.audienceCounter();
    return created.map((assignment) => this.toSummary(assignment, counter));
  }

  /**
   * Turn the requested campus and batch selectors into validated audiences.
   *
   * Every returned scope is legal by construction: a batch always carries its own
   * campus, so `{ campusId: null, batchId: <id> }` — the one combination that could
   * contradict itself — cannot be produced here.
   */
  private async resolveTargetScopes(
    campusSelector: string | undefined,
    batchSelectors: string[] | undefined,
  ): Promise<AudienceScope[]> {
    const campusRaw = (campusSelector ?? '').trim();
    const campusId =
      campusRaw === '' || ALL_TARGETS.has(campusRaw.toUpperCase())
        ? null
        : await this.campuses.resolveSelector(campusRaw);

    const batches = (batchSelectors ?? []).filter(
      (selector) => selector.trim() !== '' && !ALL_TARGETS.has(selector.trim().toUpperCase()),
    );

    if (batches.length === 0) {
      // Whole campus, or literally everyone. Both are single rows.
      return [{ campusId, batchId: null }];
    }

    const scopes: AudienceScope[] = [];
    for (const selector of batches) {
      const batch = await this.campuses.findBatch(campusId, selector);

      if (campusId !== null && batch.campusId !== campusId) {
        throw new BadRequestException(
          `Batch "${batch.name}" does not belong to the selected campus. ` +
            'Pick a batch from that campus, or change the campus.',
        );
      }
      if (batch.status !== 'ACTIVE') {
        // Assigning work to a batch nobody is in creates rows no student is ever
        // evaluated against — a silent no-op that looks like a successful create.
        throw new BadRequestException(
          `Batch "${batch.name}" is archived and cannot receive new assignments.`,
        );
      }

      const scope: AudienceScope = { campusId: batch.campusId, batchId: batch.id };
      if (!isLegalScope(scope)) {
        throw new BadRequestException(`Batch "${batch.name}" resolved to an invalid audience.`);
      }
      if (!scopes.some((existing) => existing.batchId === scope.batchId)) scopes.push(scope);
    }
    return scopes;
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
    return this.toSummary(assignment, await this.audienceCounter());
  }

  /**
   * "Change Assignment Target" (§9): reconfigure which campus and batch an existing
   * assignment currently applies to.
   *
   * What this does *not* do is touch a single `DailyStatus` row. Every day already
   * computed against this assignment stays computed against it: `RollupService` freezes
   * `DailyStatus.assignmentId` the first time a day is scored and never swaps it for a
   * different assignment on a later recompute, so retargeting cannot silently rewrite a
   * result that already exists. `originalCampusId`/`originalBatchId` are never touched
   * either, so the UI can always show what this assignment *was* alongside what it is now.
   */
  async changeTarget(
    id: string,
    dto: ChangeAssignmentTargetDto,
    user: { id: string; name: string },
  ): Promise<AssignmentSummary> {
    const existing = await this.prisma.assignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Assignment ${id} was not found`);

    const target = await this.resolveRetarget(dto);

    if (target.campusId === existing.campusId && target.batchId === existing.batchId) {
      throw new BadRequestException(
        `This assignment already targets ${await this.describeAudience(target)}.`,
      );
    }

    // The partial/composite unique indexes already enforce this at the database level,
    // but resolving it here gives a mentor-readable error instead of a raw constraint
    // violation.
    const clash = await this.prisma.assignment.findFirst({
      where: {
        dayKey: existing.dayKey,
        campusId: target.campusId,
        batchId: target.batchId,
        id: { not: id },
      },
      include: { batch: { select: { name: true } }, campus: { select: { name: true } } },
    });
    if (clash) {
      throw new BadRequestException(
        `${existing.dayKey} already has a separate assignment for ` +
          `${describeScope(clash.campus?.name ?? null, clash.batch?.name ?? null)}. ` +
          'Update or delete that one first.',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id },
        data: { campusId: target.campusId, batchId: target.batchId },
      });
      await tx.assignmentAudienceChange.create({
        data: {
          assignmentId: id,
          fromCampusId: existing.campusId,
          toCampusId: target.campusId,
          fromBatchId: existing.batchId,
          toBatchId: target.batchId,
          reason: dto.reason?.trim() || null,
          changedById: user.id,
          changedByName: user.name,
        },
      });
      // Re-read with the full include *after* both writes land, so the audience-change
      // row just created is the one `toSummary` sees as "latest" (`audienceChangedAt`).
      return tx.assignment.findUniqueOrThrow({ where: { id }, include: this.include() });
    });

    await this.invalidate(existing.dayKey);

    this.logger.log(
      `Retargeted assignment ${id} (${existing.dayKey}) to ` +
        `${target.campusId ?? 'all campuses'}/${target.batchId ?? 'all batches'}`,
    );

    return this.toSummary(updated, await this.audienceCounter());
  }

  /**
   * Resolve a retarget request into a legal audience.
   *
   * `target`/`campus` of `BOTH`/`ALL` widens that half. Naming a batch always pins the
   * campus to that batch's own, so a retarget cannot produce the illegal
   * "batch without campus" pair even if the caller asks for it.
   */
  private async resolveRetarget(dto: ChangeAssignmentTargetDto): Promise<AudienceScope> {
    const campusRaw = (dto.campus ?? '').trim();
    const campusId =
      campusRaw === '' || ALL_TARGETS.has(campusRaw.toUpperCase())
        ? null
        : await this.campuses.resolveSelector(campusRaw);

    const targetRaw = (dto.target ?? '').trim();
    if (targetRaw === '' || ALL_TARGETS.has(targetRaw.toUpperCase())) {
      return { campusId, batchId: null };
    }

    const batch = await this.campuses.findBatch(campusId, targetRaw);
    if (campusId !== null && batch.campusId !== campusId) {
      throw new BadRequestException(
        `Batch "${batch.name}" does not belong to the campus requested.`,
      );
    }
    return { campusId: batch.campusId, batchId: batch.id };
  }

  private async describeAudience(scope: AudienceScope): Promise<string> {
    const [campus, batch] = await Promise.all([
      scope.campusId
        ? this.prisma.campus.findUnique({ where: { id: scope.campusId }, select: { name: true } })
        : null,
      scope.batchId
        ? this.prisma.batch.findUnique({ where: { id: scope.batchId }, select: { name: true } })
        : null,
    ]);
    return describeScope(campus?.name ?? null, batch?.name ?? null);
  }

  /** Every retarget event for an assignment, newest first — the audit trail behind §9. */
  async audienceHistory(id: string): Promise<AssignmentAudienceChangeEntry[]> {
    const rows = await this.prisma.assignmentAudienceChange.findMany({
      where: { assignmentId: id },
      include: {
        fromBatch: { select: { name: true, code: true } },
        toBatch: { select: { name: true, code: true } },
        fromCampus: { select: { name: true, code: true } },
        toCampus: { select: { name: true, code: true } },
      },
      orderBy: { changedAt: 'desc' },
    });

    return rows.map(
      (row): AssignmentAudienceChangeEntry => ({
        id: row.id,
        assignmentId: row.assignmentId,
        fromCampusId: row.fromCampusId,
        fromCampusName: row.fromCampus?.name ?? null,
        fromCampusCode: row.fromCampus?.code ?? null,
        toCampusId: row.toCampusId,
        toCampusName: row.toCampus?.name ?? null,
        toCampusCode: row.toCampus?.code ?? null,
        fromBatchId: row.fromBatchId,
        fromBatchName: row.fromBatch?.name ?? null,
        fromBatchCode: row.fromBatch?.code ?? null,
        toBatchId: row.toBatchId,
        toBatchName: row.toBatch?.name ?? null,
        toBatchCode: row.toBatch?.code ?? null,
        reason: row.reason,
        changedById: row.changedById,
        changedByName: row.changedByName,
        changedAt: row.changedAt.toISOString(),
      }),
    );
  }

  /**
   * Delete an assignment and re-settle the day it belonged to.
   *
   * The recompute is the point, not housekeeping. `DailyStatus.assignmentId` is `SetNull`,
   * so the delete on its own leaves every student's row for that day still claiming
   * `assignedCount = 4` while naming no assignment — a whole batch recorded as having
   * missed four problems on a day that no longer has any, which reads as a false zero on
   * the report, the leaderboard and their streaks.
   *
   * Clearing the cache was never enough, and neither was leaving it to the sync's
   * stale-day detector: that detector starts `FROM assignments`, so the one row it would
   * need to notice this by is the row that was just deleted. (It has since grown a second
   * arm that finds these days from the wreckage, which is what repairs days already
   * damaged — but an admin who deletes an assignment should see the numbers corrected now,
   * not at the next sync.)
   *
   * Recomputed rather than zeroed, because deleting one assignment can change which
   * assignment applies: a batch-targeted set removed may mean the campus-wide set now
   * reaches those students, and only a real recompute resolves that.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.prisma.assignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Assignment ${id} was not found`);
    await this.prisma.assignment.delete({ where: { id } });
    await this.rollup.recomputeDay(existing.dayKey);
    await this.rollup.rebuildLeaderboards(existing.dayKey);
    await this.invalidate(existing.dayKey);
  }

  /**
   * The assignment that applies to one campus + batch on `dayKey`.
   *
   * Widens through the three tiers defined by `selectAssignmentForScope`, so a student
   * whose batch has nothing that day still receives their campus's set, and a
   * campus-agnostic set still reaches everyone. A *different* campus's or batch's
   * assignment is never returned — that is the leak §9 forbids.
   */
  async findByDay(dayKey: DayKey, scope: AudienceScope): Promise<AssignmentSummary | null> {
    const assignments = await this.prisma.assignment.findMany({
      where: { dayKey, ...this.applicableWhere(scope) },
      include: this.include(),
    });

    const selected = selectAssignmentForScope(assignments, scope);
    return selected ? this.toSummary(selected, await this.audienceCounter()) : null;
  }

  /**
   * Every audience's assignment for a day — what the campus-aware daily tracker renders.
   *
   * `scope` narrows which audiences are listed but does *not* collapse them: asking for
   * `campus=SRM` returns SRM/Foundation and SRM/Intermediate as separate rows, because
   * they are separate problem sets and merging them would misreport both (§11).
   */
  async findAllByDay(dayKey: DayKey, scope?: AudienceScope): Promise<AssignmentSummary[]> {
    const assignments = await this.prisma.assignment.findMany({
      where: { dayKey, ...(scope ? this.listWhere(scope) : {}) },
      include: this.include(),
      orderBy: [
        { campus: { sortOrder: 'asc' } },
        { batch: { sortOrder: 'asc' } },
        { createdAt: 'asc' },
      ],
    });
    const counter = await this.audienceCounter();
    return assignments.map((assignment) => this.toSummary(assignment, counter));
  }

  async findToday(scope: AudienceScope): Promise<AssignmentSummary | null> {
    return this.findByDay(this.time.today(), scope);
  }

  /** A single assignment by id, with the same shape `findByDay`/`findAll` return. */
  async findById(id: string): Promise<AssignmentSummary | null> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id },
      include: this.include(),
    });
    return assignment ? this.toSummary(assignment, await this.audienceCounter()) : null;
  }

  /** Every audience's set for today, in program-local time. */
  async findAllToday(scope?: AudienceScope): Promise<AssignmentSummary[]> {
    return this.findAllByDay(this.time.today(), scope);
  }

  /**
   * The campus an assignment belongs to, or `undefined` when there is no such assignment.
   *
   * Deliberately distinguishes "no campus" (`null` — targeted at the whole programme)
   * from "no such row" (`undefined`), because the authorization check above treats them
   * differently: everyone may read a programme-wide assignment, nobody may read one that
   * does not exist.
   */
  async findCampusOf(id: string): Promise<string | null | undefined> {
    const row = await this.prisma.assignment.findUnique({
      where: { id },
      select: { campusId: true },
    });
    return row === null ? undefined : row.campusId;
  }

  async findAll(query: {
    page: number;
    pageSize: number;
    from?: string;
    to?: string;
    search?: string;
    scope?: AudienceScope;
  }): Promise<Paginated<AssignmentSummary>> {
    const where = {
      ...(query.scope ? this.listWhere(query.scope) : {}),
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
        orderBy: [
          { dayKey: 'desc' },
          { campus: { sortOrder: 'asc' } },
          { batch: { sortOrder: 'asc' } },
        ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.assignment.count({ where }),
    ]);

    const counter = await this.audienceCounter();
    return paginate(
      rows.map((row) => this.toSummary(row, counter)),
      total,
      query.page,
      query.pageSize,
    );
  }

  /**
   * `WHERE` matching every assignment that *applies to* one exact audience.
   *
   * The SQL half of `selectAssignmentForScope`'s three tiers: narrow the read to the rows
   * that could possibly win, then let the pure function pick between them. Written as an
   * OR of exact tuples rather than as `campusId IN (X, NULL)`, because SQL `IN` never
   * matches NULL and the tier-3 row would silently vanish.
   */
  private applicableWhere(scope: AudienceScope) {
    const clauses: { campusId: string | null; batchId: string | null }[] = [
      { campusId: null, batchId: null },
    ];
    if (scope.campusId !== null) {
      clauses.push({ campusId: scope.campusId, batchId: null });
      if (scope.batchId !== null) {
        clauses.push({ campusId: scope.campusId, batchId: scope.batchId });
      }
    }
    return { OR: clauses };
  }

  /**
   * `WHERE` for *listing* under a filter, which is broader than `applicableWhere`.
   *
   * Filtering to a campus should show everything that campus received — including its
   * other batches' rows — rather than only what one batch would have been evaluated
   * against. The two differ precisely when a campus is named without a batch.
   */
  private listWhere(scope: AudienceScope) {
    if (scope.campusId === null) return {};
    if (scope.batchId === null) {
      return { OR: [{ campusId: scope.campusId }, { campusId: null, batchId: null }] };
    }
    return { OR: this.applicableWhere(scope).OR };
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

  /**
   * How many active students each audience would reach — resolved once per response.
   *
   * One grouped query over the whole active roster, then counted in memory per row. See
   * `AudienceCounter` for why this is not a count per assignment.
   */
  private async audienceCounter(): Promise<AudienceCounter> {
    const groups = await this.prisma.student.groupBy({
      by: ['campusId', 'batchId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    });
    return new AudienceCounter(
      groups.map((group) => ({
        campusId: group.campusId,
        batchId: group.batchId,
        count: group._count._all,
      })),
    );
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
      batch: { select: { name: true, code: true } },
      campus: { select: { name: true, code: true } },
      originalBatch: { select: { name: true, code: true } },
      originalCampus: { select: { name: true, code: true } },
      // Only the latest change is needed to answer "has this been retargeted, and when";
      // the full trail is fetched separately via `audienceHistory` when a mentor asks.
      audienceChanges: { orderBy: { changedAt: 'desc' as const }, take: 1 },
    };
  }

  private async invalidate(dayKey: DayKey): Promise<void> {
    await Promise.all([
      this.cache.delByPrefix(`dashboard:${dayKey}`),
      this.cache.delByPrefix(`mentor:${dayKey}`),
      this.cache.delByPrefix(`leaderboard:`),
    ]);
  }

  private toSummary(
    assignment: {
      id: string;
      dayKey: string;
      campusId: string | null;
      campus?: { name: string; code: string } | null;
      batchId: string | null;
      batch?: { name: string; code: string } | null;
      originalCampusId: string | null;
      originalCampus?: { name: string; code: string } | null;
      originalBatchId: string | null;
      originalBatch?: { name: string; code: string } | null;
      audienceChanges?: { changedAt: Date }[];
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
    },
    counter: AudienceCounter,
  ): AssignmentSummary {
    return {
      id: assignment.id,
      dayKey: assignment.dayKey,
      campusId: assignment.campusId,
      campusName: assignment.campus?.name ?? null,
      campusCode: assignment.campus?.code ?? null,
      batchId: assignment.batchId,
      batchName: assignment.batch?.name ?? null,
      batchCode: assignment.batch?.code ?? null,
      audienceLabel: describeScope(
        assignment.campus?.name ?? null,
        assignment.batch?.name ?? null,
      ),
      studentCount: counter.countFor({
        campusId: assignment.campusId,
        batchId: assignment.batchId,
      }),
      originalCampusId: assignment.originalCampusId,
      originalCampusName: assignment.originalCampus?.name ?? null,
      originalCampusCode: assignment.originalCampus?.code ?? null,
      originalBatchId: assignment.originalBatchId,
      originalBatchName: assignment.originalBatch?.name ?? null,
      originalBatchCode: assignment.originalBatch?.code ?? null,
      audienceChangedAt: assignment.audienceChanges?.[0]?.changedAt.toISOString() ?? null,
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
