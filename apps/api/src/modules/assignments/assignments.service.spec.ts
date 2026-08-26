/**
 * `AssignmentsService` — campus + batch targeting (§9, §10, §11).
 *
 * The properties worth protecting, in order of how badly getting them wrong would hurt:
 *
 *  - **No cross-campus leak.** An SRM student is never evaluated against Vels' problems,
 *    and vice versa. This is the one that would quietly corrupt every report if it broke.
 *  - Uniqueness is `(dayKey, campusId, batchId)`. One date carries four independent sets
 *    — Vels/Foundation, Vels/Intermediate, SRM/Foundation, SRM/Intermediate — and
 *    creating any of them never touches or blocks on the others.
 *  - Selecting a specific audience only checks *that* audience for a clash.
 *  - Omitting both halves means one "everyone" row, not a fan-out into one row per batch.
 *  - Resolution widens: batch → campus → everyone, most specific first.
 *  - "Change Assignment Target" moves an audience and records why, without silently
 *    colliding with another assignment already on that date.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignmentsService } from './assignments.service';

const VELS = 'campus-vels';
const SRM = 'campus-srm';

const VELS_FOUNDATION = 'batch-vels-a';
const VELS_INTERMEDIATE = 'batch-vels-b';
const SRM_FOUNDATION = 'batch-srm-a';
const SRM_INTERMEDIATE = 'batch-srm-b';


const PROBLEM_URLS = [
  'https://leetcode.com/problems/maximum-number-of-vowels-in-a-substring-of-given-length/',
  'https://leetcode.com/problems/permutation-in-string/',
  'https://leetcode.com/problems/find-all-anagrams-in-a-string/',
  'https://leetcode.com/problems/max-consecutive-ones-iii/',
];

const SLUGS = [
  'maximum-number-of-vowels-in-a-substring-of-given-length',
  'permutation-in-string',
  'find-all-anagrams-in-a-string',
  'max-consecutive-ones-iii',
];

function problemRow(slug: string) {
  return {
    id: `problem-${slug}`,
    titleSlug: slug,
    title: slug,
    questionId: null,
    questionFrontendId: null,
    difficulty: 'MEDIUM',
    acceptanceRate: null,
    isPaidOnly: false,
    topicTags: [],
    companyTags: [],
    url: `https://leetcode.com/problems/${slug}/`,
  };
}

interface FakeAssignment {
  id: string;
  dayKey: string;
  campusId: string | null;
  batchId: string | null;
  originalCampusId: string | null;
  originalBatchId: string | null;
  campus: { name: string; code: string } | null;
  batch: { name: string; code: string } | null;
  originalCampus: { name: string; code: string } | null;
  originalBatch: { name: string; code: string } | null;
  audienceChanges: { changedAt: Date }[];
  title: string | null;
  topic: string | null;
  notes: string | null;
  difficulty: string | null;
  createdAt: Date;
  createdBy: null;
  problems: { id: string; position: number; problem: ReturnType<typeof problemRow> }[];
}

const CAMPUS_DIRECTORY: Record<string, { name: string; code: string }> = {
  [VELS]: { name: 'Vels Institute', code: 'VELS' },
  [SRM]: { name: 'SRM University', code: 'SRM' },
};

const BATCH_DIRECTORY: Record<
  string,
  { name: string; code: string; campusId: string; status: string }
> = {
  [VELS_FOUNDATION]: { name: 'Foundation Level', code: 'A', campusId: VELS, status: 'ACTIVE' },
  [VELS_INTERMEDIATE]: { name: 'Intermediate Level', code: 'B', campusId: VELS, status: 'ACTIVE' },
  [SRM_FOUNDATION]: { name: 'Foundation Level', code: 'A', campusId: SRM, status: 'ACTIVE' },
  [SRM_INTERMEDIATE]: { name: 'Intermediate Level', code: 'B', campusId: SRM, status: 'ACTIVE' },
};

/** Shorthand for a stored row, so the scenarios below stay readable. */
function assignmentRow(
  id: string,
  dayKey: string,
  campusId: string | null,
  batchId: string | null,
): FakeAssignment {
  return {
    id,
    dayKey,
    campusId,
    batchId,
    originalCampusId: campusId,
    originalBatchId: batchId,
    campus: campusId ? CAMPUS_DIRECTORY[campusId]! : null,
    batch: batchId ? BATCH_DIRECTORY[batchId]! : null,
    originalCampus: campusId ? CAMPUS_DIRECTORY[campusId]! : null,
    originalBatch: batchId ? BATCH_DIRECTORY[batchId]! : null,
    audienceChanges: [],
    title: null,
    topic: null,
    notes: null,
    difficulty: null,
    createdAt: new Date(),
    createdBy: null,
    problems: [],
  };
}

function makeService(
  options: { existing?: FakeAssignment[]; archivedBatchIds?: string[] } = {},
) {
  const rows: FakeAssignment[] = [...(options.existing ?? [])];
  const archived = new Set(options.archivedBatchIds ?? []);
  const problemsBySlug = new Map(SLUGS.map((slug) => [slug, problemRow(slug)]));
  let nextId = rows.length + 1;

  // Every read below returns a *shallow copy*, exactly like a real Prisma client hands
  // back a fresh object per query — never the same reference `rows` holds. Without this,
  // a later `update()` mutating the stored row would retroactively corrupt an "existing"
  // snapshot a caller captured earlier in the same request (as `changeTarget` does).
  const clone = (row: FakeAssignment): FakeAssignment => ({ ...row });

  /** Matches the `OR: [{ campusId, batchId }, …]` shape the service builds. */
  const matchesOr = (
    row: FakeAssignment,
    or: { campusId?: string | null; batchId?: string | null }[] | undefined,
  ): boolean => {
    if (!or) return true;
    return or.some((clause) => {
      if ('campusId' in clause && clause.campusId !== undefined && row.campusId !== clause.campusId)
        return false;
      if ('batchId' in clause && clause.batchId !== undefined && row.batchId !== clause.batchId)
        return false;
      return true;
    });
  };

  const prisma = {
    assignment: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows
          .filter((row) => {
            if (where.dayKey !== undefined && row.dayKey !== where.dayKey) return false;
            return matchesOr(row, where.OR as never);
          })
          .map(clone),
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            dayKey: string;
            campusId: string | null;
            batchId: string | null;
            id?: { not: string };
          };
        }) => {
          const found = rows.find(
            (row) =>
              row.dayKey === where.dayKey &&
              row.campusId === where.campusId &&
              row.batchId === where.batchId &&
              (!where.id || row.id !== where.id.not),
          );
          return found ? clone(found) : null;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const found = rows.find((row) => row.id === where.id);
        return found ? clone(found) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        return clone(row);
      }),
      count: vi.fn(async () => rows.length),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        if (index === -1) throw new Error('not found');
        return clone(rows.splice(index, 1)[0]!);
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            dayKey: string;
            campusId: string | null;
            batchId: string | null;
            originalCampusId: string | null;
            originalBatchId: string | null;
            title: string | null;
            topic: string | null;
            notes: string | null;
            difficulty: string | null;
            problems: { create: { problemId: string; position: number }[] };
          };
        }) => {
          const row = assignmentRow(
            `assignment-${nextId++}`,
            data.dayKey,
            data.campusId,
            data.batchId,
          );
          row.title = data.title;
          row.topic = data.topic;
          row.notes = data.notes;
          row.difficulty = data.difficulty;
          row.problems = data.problems.create.map((p) => ({
            id: `link-${p.position}`,
            position: p.position,
            problem: [...problemsBySlug.values()].find((pr) => pr.id === p.problemId)!,
          }));
          rows.push(row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { campusId: string | null; batchId: string | null };
        }) => {
          const row = rows.find((r) => r.id === where.id)!;
          row.campusId = data.campusId;
          row.batchId = data.batchId;
          row.campus = data.campusId ? CAMPUS_DIRECTORY[data.campusId]! : null;
          row.batch = data.batchId ? BATCH_DIRECTORY[data.batchId]! : null;
          return row;
        },
      ),
    },
    problem: {
      findUnique: vi.fn(
        async ({ where }: { where: { titleSlug: string } }) =>
          problemsBySlug.get(where.titleSlug) ?? null,
      ),
    },
    batch: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id && BATCH_DIRECTORY[where.id]
          ? { id: where.id, ...BATCH_DIRECTORY[where.id] }
          : null,
      ),
    },
    campus: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id && CAMPUS_DIRECTORY[where.id]
          ? { id: where.id, ...CAMPUS_DIRECTORY[where.id] }
          : null,
      ),
    },
    // Backs `audienceCounter`: 12 active students spread over four groups.
    student: {
      groupBy: vi.fn(async () => [
        { campusId: VELS, batchId: VELS_FOUNDATION, _count: { _all: 15 } },
        { campusId: VELS, batchId: VELS_INTERMEDIATE, _count: { _all: 16 } },
        { campusId: SRM, batchId: null, _count: { _all: 92 } },
      ]),
    },
    assignmentAudienceChange: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
    }),
  };

  const cache = {
    delByPrefix: vi.fn(async () => undefined),
    remember: vi.fn(async (_key: string, _ttl: number, fn: () => unknown) => fn()),
  };
  const time = {
    isValid: (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d),
    today: () => '2026-08-13',
  };

  /** A stand-in for `CampusesService` with the same resolution contract. */
  const campuses = {
    resolveSelector: vi.fn(async (value?: string | null) => {
      if (value === undefined || value === null) return null;
      const v = value.trim().toUpperCase();
      if (v === '' || v === 'ALL') return null;
      const entry = Object.entries(CAMPUS_DIRECTORY).find(
        ([id, campus]) => campus.code === v || id === value,
      );
      if (!entry) throw new BadRequestException(`"${value}" is not a known campus.`);
      return entry[0];
    }),
    findBatch: vi.fn(async (campusId: string | null, selector: string) => {
      if (BATCH_DIRECTORY[selector]) {
        const batch = BATCH_DIRECTORY[selector]!;
        return { id: selector, ...batch, status: archived.has(selector) ? 'ARCHIVED' : batch.status };
      }
      const code = selector.trim().toUpperCase().replace('FOUNDATION', 'A').replace('INTERMEDIATE', 'B');
      const matches = Object.entries(BATCH_DIRECTORY).filter(
        ([id, batch]) => batch.code === code && (campusId === null || batch.campusId === campusId),
      );
      if (matches.length === 0) {
        throw new BadRequestException(`"${selector}" is not a known batch.`);
      }
      if (matches.length > 1) {
        throw new BadRequestException(`"${selector}" names a batch at several campuses.`);
      }
      const [id, batch] = matches[0]!;
      return { id, ...batch, status: archived.has(id) ? 'ARCHIVED' : batch.status };
    }),
    resolveScope: vi.fn(async () => ({
      campusId: null,
      batchId: null,
      campusName: null,
      campusCode: null,
      batchName: null,
      batchCode: null,
    })),
  };

  const provider = { fetchProblemMetadata: vi.fn() };

  const rollup = {
    recomputeDay: vi.fn().mockResolvedValue({ students: 0, assigned: 0 }),
    rebuildLeaderboards: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AssignmentsService(
    prisma as never,
    cache as never,
    time as never,
    campuses as never,
    rollup as never,
    provider as never,
  );
  return { service, prisma, rows, campuses, rollup };
}

describe('AssignmentsService.create — four independent scopes on one date', () => {
  it('gives Vels/Foundation, Vels/Intermediate, SRM/Foundation and SRM/Intermediate their own rows', async () => {
    // The central §9 scenario, built one create at a time exactly as an admin would.
    const { service, rows } = makeService();

    await service.create(
      { dayKey: '2026-08-13', campus: 'VELS', batches: ['A'], problemUrls: PROBLEM_URLS },
      'user-1',
    );
    await service.create(
      { dayKey: '2026-08-13', campus: 'VELS', batches: ['B'], problemUrls: PROBLEM_URLS },
      'user-1',
    );
    await service.create(
      { dayKey: '2026-08-13', campus: 'SRM', batches: ['A'], problemUrls: PROBLEM_URLS },
      'user-1',
    );
    await service.create(
      { dayKey: '2026-08-13', campus: 'SRM', batches: ['B'], problemUrls: PROBLEM_URLS },
      'user-1',
    );

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => `${row.campusId}/${row.batchId}`).sort()).toEqual(
      [
        `${SRM}/${SRM_FOUNDATION}`,
        `${SRM}/${SRM_INTERMEDIATE}`,
        `${VELS}/${VELS_FOUNDATION}`,
        `${VELS}/${VELS_INTERMEDIATE}`,
      ].sort(),
    );
  });

  it('creates SRM/Foundation even though Vels/Foundation already has one that day', async () => {
    // Same date, same batch *code*, different campus. Blocking here would be the
    // cross-campus collision §9 explicitly forbids.
    const { service, rows } = makeService({
      existing: [assignmentRow('existing-vels-a', '2026-08-13', VELS, VELS_FOUNDATION)],
    });

    const created = await service.create(
      { dayKey: '2026-08-13', campus: 'SRM', batches: ['foundation'], problemUrls: PROBLEM_URLS },
      'user-1',
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.campusCode).toBe('SRM');
    expect(rows).toHaveLength(2);
  });

  it('refuses a second SRM/Foundation assignment the same day, naming only that audience', async () => {
    const { service } = makeService({
      existing: [
        assignmentRow('existing-srm-a', '2026-08-13', SRM, SRM_FOUNDATION),
        assignmentRow('existing-vels-a', '2026-08-13', VELS, VELS_FOUNDATION),
      ],
    });

    await expect(
      service.create(
        { dayKey: '2026-08-13', campus: 'SRM', batches: ['A'], problemUrls: PROBLEM_URLS },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);

    // The error must name the audience that actually clashed, not the other campus's.
    await service
      .create(
        { dayKey: '2026-08-13', campus: 'SRM', batches: ['A'], problemUrls: PROBLEM_URLS },
        'user-1',
      )
      .catch((error: Error) => {
        expect(error.message).toContain('SRM University');
        expect(error.message).not.toContain('Vels');
      });
  });

  it('rejects a batch that belongs to another campus rather than silently retargeting it', async () => {
    const { service } = makeService();

    await expect(
      service.create(
        {
          dayKey: '2026-08-13',
          campus: 'SRM',
          batches: [VELS_FOUNDATION],
          problemUrls: PROBLEM_URLS,
        },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown campus rather than silently widening to every campus', async () => {
    const { service } = makeService();
    await expect(
      service.create(
        { dayKey: '2026-08-13', campus: 'NOWHERE', batches: ['A'], problemUrls: PROBLEM_URLS },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses to assign to an archived batch', async () => {
    const { service } = makeService({ archivedBatchIds: [SRM_INTERMEDIATE] });
    await expect(
      service.create(
        { dayKey: '2026-08-13', campus: 'SRM', batches: ['B'], problemUrls: PROBLEM_URLS },
        'user-1',
      ),
    ).rejects.toThrow(/archived/i);
  });
});

describe('AssignmentsService.create — widening targets', () => {
  it('creates one whole-campus row when a campus is named with no batches', async () => {
    const { service, rows } = makeService();

    const created = await service.create(
      { dayKey: '2026-08-13', campus: 'SRM', problemUrls: PROBLEM_URLS },
      'user-1',
    );

    expect(created).toHaveLength(1);
    expect(rows[0]?.campusId).toBe(SRM);
    expect(rows[0]?.batchId).toBeNull();
  });

  it('creates exactly one "everyone" row when neither half is named', async () => {
    // Deliberately *not* a fan-out into one row per batch. With two campuses that would
    // manufacture five assignments from a form the admin filled in once (§10).
    const { service, rows } = makeService();

    const created = await service.create(
      { dayKey: '2026-08-13', problemUrls: PROBLEM_URLS },
      'user-1',
    );

    expect(created).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.campusId).toBeNull();
    expect(rows[0]?.batchId).toBeNull();
  });

  it('reports how many active students an audience reaches', async () => {
    const { service } = makeService();
    const created = await service.create(
      { dayKey: '2026-08-13', campus: 'SRM', problemUrls: PROBLEM_URLS },
      'user-1',
    );
    // Every SRM student, regardless of batch — 92 in the fixture.
    expect(created[0]?.studentCount).toBe(92);
  });

  it('labels the audience the way the preview renders it', async () => {
    const { service } = makeService();
    const created = await service.create(
      { dayKey: '2026-08-13', campus: 'SRM', batches: ['A'], problemUrls: PROBLEM_URLS },
      'user-1',
    );
    expect(created[0]?.audienceLabel).toBe('SRM University — Foundation Level');
  });

  it('says "all campuses" explicitly rather than leaving the label half blank', async () => {
    const { service } = makeService();
    const created = await service.create(
      { dayKey: '2026-08-13', problemUrls: PROBLEM_URLS },
      'user-1',
    );
    expect(created[0]?.audienceLabel).toBe('All campuses — All batches');
  });

  it('writes an all-or-nothing multi-batch create, or nothing at all', async () => {
    const { service, rows } = makeService({
      existing: [assignmentRow('existing-srm-b', '2026-08-13', SRM, SRM_INTERMEDIATE)],
    });

    await expect(
      service.create(
        { dayKey: '2026-08-13', campus: 'SRM', batches: ['A', 'B'], problemUrls: PROBLEM_URLS },
        'user-1',
      ),
    ).rejects.toThrow(BadRequestException);

    // Foundation must not have been created "on the way" to discovering the clash.
    expect(rows).toHaveLength(1);
  });
});

describe('AssignmentsService.findByDay — resolution never crosses a campus', () => {
  const day = '2026-08-13';

  it('gives each audience its own set on a four-way day', async () => {
    const { service } = makeService({
      existing: [
        assignmentRow('vels-a', day, VELS, VELS_FOUNDATION),
        assignmentRow('vels-b', day, VELS, VELS_INTERMEDIATE),
        assignmentRow('srm-a', day, SRM, SRM_FOUNDATION),
        assignmentRow('srm-b', day, SRM, SRM_INTERMEDIATE),
      ],
    });

    expect(
      (await service.findByDay(day, { campusId: VELS, batchId: VELS_FOUNDATION }))?.id,
    ).toBe('vels-a');
    expect(
      (await service.findByDay(day, { campusId: SRM, batchId: SRM_FOUNDATION }))?.id,
    ).toBe('srm-a');
    expect(
      (await service.findByDay(day, { campusId: SRM, batchId: SRM_INTERMEDIATE }))?.id,
    ).toBe('srm-b');
  });

  it('returns nothing rather than the other campus’s set', async () => {
    // The leak that would matter most: an SRM student handed Vels' questions.
    const { service } = makeService({
      existing: [assignmentRow('vels-a', day, VELS, VELS_FOUNDATION)],
    });

    expect(await service.findByDay(day, { campusId: SRM, batchId: SRM_FOUNDATION })).toBeNull();
  });

  it('falls back to the campus-wide row, then to the everyone row', async () => {
    const { service } = makeService({
      existing: [
        assignmentRow('everyone', day, null, null),
        assignmentRow('srm-all', day, SRM, null),
        assignmentRow('srm-a', day, SRM, SRM_FOUNDATION),
      ],
    });

    expect((await service.findByDay(day, { campusId: SRM, batchId: SRM_FOUNDATION }))?.id).toBe(
      'srm-a',
    );
    expect(
      (await service.findByDay(day, { campusId: SRM, batchId: SRM_INTERMEDIATE }))?.id,
    ).toBe('srm-all');
    expect(
      (await service.findByDay(day, { campusId: VELS, batchId: VELS_FOUNDATION }))?.id,
    ).toBe('everyone');
  });

  /**
   * A student with no batch still belongs to a campus, so campus-wide work reaches them.
   * Level-specific work does not — that is asserted separately below.
   */
  it('reaches an unassigned student through the campus-wide row', async () => {
    const { service } = makeService({
      existing: [assignmentRow('srm-all', day, SRM, null)],
    });
    expect((await service.findByDay(day, { campusId: SRM, batchId: null }))?.id).toBe('srm-all');
  });

  it('never gives an unassigned student a level-specific assignment', async () => {
    // Work is set for a level. Someone who has not been placed into one has no level's
    // work to do, and inventing a placement to give them some would be worse than none.
    const { service } = makeService({
      existing: [
        assignmentRow('srm-a', day, SRM, SRM_FOUNDATION),
        assignmentRow('srm-b', day, SRM, SRM_INTERMEDIATE),
      ],
    });
    expect(await service.findByDay(day, { campusId: SRM, batchId: null })).toBeNull();
  });
});

describe('AssignmentsService.changeTarget', () => {
  const day = '2026-08-13';

  it('retargets to another campus and records the change', async () => {
    const { service, prisma } = makeService({
      existing: [assignmentRow('a1', day, null, null)],
    });

    const updated = await service.changeTarget(
      'a1',
      { campus: 'SRM', target: 'A', reason: 'Vels had a different plan' },
      { id: 'user-1', name: 'Admin' },
    );

    expect(updated.campusId).toBe(SRM);
    expect(updated.batchId).toBe(SRM_FOUNDATION);
    // The original audience is frozen, so the UI can show "was everyone, now SRM/A".
    expect(updated.originalCampusId).toBeNull();
    expect(updated.originalBatchId).toBeNull();
    expect(prisma.assignmentAudienceChange.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toCampusId: SRM,
          toBatchId: SRM_FOUNDATION,
          reason: 'Vels had a different plan',
        }),
      }),
    );
  });

  it('refuses a retarget that would collide with an existing audience that day', async () => {
    const { service } = makeService({
      existing: [
        assignmentRow('a1', day, VELS, VELS_FOUNDATION),
        assignmentRow('a2', day, SRM, SRM_FOUNDATION),
      ],
    });

    await expect(
      service.changeTarget('a1', { campus: 'SRM', target: 'A' }, { id: 'u', name: 'Admin' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses a no-op retarget', async () => {
    const { service } = makeService({
      existing: [assignmentRow('a1', day, SRM, SRM_FOUNDATION)],
    });

    await expect(
      service.changeTarget('a1', { campus: 'SRM', target: 'A' }, { id: 'u', name: 'Admin' }),
    ).rejects.toThrow(/already targets/i);
  });

  it('404s for an assignment that does not exist', async () => {
    const { service } = makeService();
    await expect(
      service.changeTarget('nope', { target: 'BOTH' }, { id: 'u', name: 'Admin' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('AssignmentsService.findAllByDay — the history table never merges audiences', () => {
  const day = '2026-08-13';

  it('returns SRM/Foundation and Vels/Foundation as separate rows', async () => {
    // §11: "Do not merge these rows."
    const { service } = makeService({
      existing: [
        assignmentRow('vels-a', day, VELS, VELS_FOUNDATION),
        assignmentRow('srm-a', day, SRM, SRM_FOUNDATION),
      ],
    });

    const all = await service.findAllByDay(day);
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.audienceLabel).sort()).toEqual([
      'SRM University — Foundation Level',
      'Vels Institute — Foundation Level',
    ]);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Deleting an assignment has to re-settle the day it belonged to.
 *
 * `DailyStatus.assignmentId` is `SetNull`, so the delete alone leaves every student's row
 * for that day still claiming `assignedCount = 4` while naming no assignment — a whole
 * batch recorded as having missed four problems on a day that no longer has any. That is a
 * false zero on the report, the leaderboard and their streaks, and it was found in a real
 * database: 15 rows on a day with no assignment at all.
 */
describe('AssignmentsService.remove', () => {
  it('recomputes the day it deleted from', async () => {
    const { service, rows, rollup } = makeService();
    const created = await service.create(
      { dayKey: '2026-08-20', campus: 'VELS', batches: ['A'], problemUrls: PROBLEM_URLS },
      'user-1',
    );
    const id = Array.isArray(created) ? created[0]!.id : created.id;

    await service.remove(id);

    expect(rows.find((row) => row.id === id)).toBeUndefined();
    // Clearing the cache was never enough: the stale rows are in the database, not in it.
    expect(rollup.recomputeDay).toHaveBeenCalledWith('2026-08-20');
    expect(rollup.rebuildLeaderboards).toHaveBeenCalledWith('2026-08-20');
  });

  it('recomputes rather than zeroing, because a different assignment may now apply', async () => {
    // Deleting a batch-targeted set can mean the campus-wide set now reaches those
    // students. Only a real recompute resolves which assignment applies.
    const { service, rollup } = makeService();
    const created = await service.create(
      { dayKey: '2026-08-20', campus: 'VELS', batches: ['A'], problemUrls: PROBLEM_URLS },
      'user-1',
    );
    const id = Array.isArray(created) ? created[0]!.id : created.id;

    await service.remove(id);

    expect(rollup.recomputeDay).toHaveBeenCalledTimes(1);
  });

  it('does not touch anything when the assignment does not exist', async () => {
    const { service, rollup } = makeService();

    await expect(service.remove('00000000-0000-4000-8000-000000000000')).rejects.toThrow();
    expect(rollup.recomputeDay).not.toHaveBeenCalled();
  });
});
