/**
 * `AssignmentsService` — batch targeting (§20).
 *
 * The properties worth protecting:
 *
 *  - Uniqueness is `(dayKey, batchId)`, never `dayKey` alone: Foundation and Intermediate
 *    each get their own assignment for the same date, and creating one never touches or
 *    blocks on the other.
 *  - Selecting a specific batch ("Foundation only") only ever checks *that* batch for a
 *    clash — an existing Intermediate assignment must never block a Foundation create.
 *  - Omitting a target ("All batches") is the one path that is genuinely all-or-nothing:
 *    it targets every active batch at once, so if any of them already has a row that day,
 *    nothing is written, by design (never a partial multi-batch create).
 *  - A legacy pre-batch assignment (`batchId = NULL`) keeps applying to every batch that
 *    has no assignment of its own, unchanged.
 *  - "Change Assignment Target" moves an assignment's audience and records why, without
 *    silently colliding with another assignment already on that date.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignmentsService } from './assignments.service';

const FOUNDATION_ID = 'batch-a';
const INTERMEDIATE_ID = 'batch-b';

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
  batchId: string | null;
  originalBatchId: string | null;
  batch: { name: string; code: string } | null;
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

const BATCH_DIRECTORY: Record<string, { name: string; code: string }> = {
  [FOUNDATION_ID]: { name: 'Foundation Level', code: 'A' },
  [INTERMEDIATE_ID]: { name: 'Intermediate Level', code: 'B' },
};

function makeService(options: { existing?: FakeAssignment[]; activeBatchIds?: string[] } = {}) {
  const rows: FakeAssignment[] = [...(options.existing ?? [])];
  const activeBatchIds = options.activeBatchIds ?? [FOUNDATION_ID, INTERMEDIATE_ID];
  const problemsBySlug = new Map(SLUGS.map((slug) => [slug, problemRow(slug)]));
  let nextId = rows.length + 1;

  // Every read below returns a *shallow copy*, exactly like a real Prisma client hands
  // back a fresh object per query — never the same reference `rows` holds. Without this,
  // a later `update()` mutating the stored row would retroactively corrupt an "existing"
  // snapshot a caller captured earlier in the same request (as `changeTarget` does).
  const clone = (row: FakeAssignment): FakeAssignment => ({ ...row });

  const prisma = {
    assignment: {
      findMany: vi.fn(async ({ where }: { where: { dayKey?: string; batchId?: unknown } }) => {
        return rows
          .filter((row) => {
            if (where.dayKey !== undefined && row.dayKey !== where.dayKey) return false;
            const batchWhere = where.batchId as { in?: (string | null)[] } | undefined;
            if (batchWhere?.in !== undefined) return batchWhere.in.includes(row.batchId);
            return true;
          })
          .map(clone);
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { dayKey: string; batchId: string | null; id?: { not: string } };
        }) => {
          const found = rows.find(
            (row) =>
              row.dayKey === where.dayKey &&
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
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            dayKey: string;
            batchId: string | null;
            originalBatchId: string | null;
            title: string | null;
            topic: string | null;
            notes: string | null;
            difficulty: string | null;
            problems: { create: { problemId: string; position: number }[] };
          };
        }) => {
          const row: FakeAssignment = {
            id: `assignment-${nextId++}`,
            dayKey: data.dayKey,
            batchId: data.batchId,
            originalBatchId: data.originalBatchId,
            batch: data.batchId ? BATCH_DIRECTORY[data.batchId]! : null,
            originalBatch: data.originalBatchId ? BATCH_DIRECTORY[data.originalBatchId]! : null,
            audienceChanges: [],
            title: data.title,
            topic: data.topic,
            notes: data.notes,
            difficulty: data.difficulty,
            createdAt: new Date(),
            createdBy: null,
            problems: data.problems.create.map((p) => ({
              id: `link-${p.position}`,
              position: p.position,
              problem: [...problemsBySlug.values()].find((pr) => pr.id === p.problemId)!,
            })),
          };
          rows.push(row);
          return row;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { batchId: string | null } }) => {
        const row = rows.find((r) => r.id === where.id)!;
        row.batchId = data.batchId;
        row.batch = data.batchId ? BATCH_DIRECTORY[data.batchId]! : null;
        return row;
      }),
    },
    problem: {
      findUnique: vi.fn(async ({ where }: { where: { titleSlug: string } }) =>
        problemsBySlug.get(where.titleSlug) ?? null,
      ),
    },
    batch: {
      findMany: vi.fn(async () => activeBatchIds.map((id) => ({ id }))),
      count: vi.fn(async ({ where }: { where: { id: string } }) =>
        activeBatchIds.includes(where.id) || Object.keys(BATCH_DIRECTORY).includes(where.id) ? 1 : 0,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id) return BATCH_DIRECTORY[where.id] ? { id: where.id, ...BATCH_DIRECTORY[where.id] } : null;
        const entry = Object.entries(BATCH_DIRECTORY).find(([, v]) => v.code === where.code);
        return entry ? { id: entry[0], ...entry[1] } : null;
      }),
    },
    assignmentAudienceChange: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
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
  const batches = {
    resolveSelector: vi.fn(async (value?: string | null) => {
      if (value === undefined || value === null) return null;
      const v = value.trim().toUpperCase();
      if (v === '' || v === 'ALL') return null;
      if (v === 'A' || v === 'FOUNDATION') return FOUNDATION_ID;
      if (v === 'B' || v === 'INTERMEDIATE') return INTERMEDIATE_ID;
      return null;
    }),
  };
  const provider = { fetchProblemMetadata: vi.fn() };

  const service = new AssignmentsService(
    prisma as never,
    cache as never,
    time as never,
    batches as never,
    provider as never,
  );
  return { service, prisma, rows };
}

describe('AssignmentsService.create — Foundation and Intermediate stay independent', () => {
  it('creates a Foundation-only assignment even though Intermediate already has one that day', async () => {
    const { service, prisma, rows } = makeService({
      existing: [
        {
          id: 'existing-b',
          dayKey: '2026-08-13',
          batchId: INTERMEDIATE_ID,
          originalBatchId: INTERMEDIATE_ID,
          batch: BATCH_DIRECTORY[INTERMEDIATE_ID]!,
          originalBatch: BATCH_DIRECTORY[INTERMEDIATE_ID]!,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
      ],
    });

    const created = await service.create(
      { dayKey: '2026-08-13', topic: 'Sliding Window', batches: ['A'], problemUrls: PROBLEM_URLS },
      'user-1',
    );

    expect(created).toHaveLength(1);
    expect(created[0]!.batchId).toBe(FOUNDATION_ID);
    expect(created[0]!.batchName).toBe('Foundation Level');
    // The exact 4 problems from the scenario, in order — Intermediate is never given
    // these; only whichever students `selectAssignmentForBatch` resolves to Foundation
    // that day are ever evaluated against them (see `batch.spec.ts`).
    expect(created[0]!.problems.map((p) => p.titleSlug)).toEqual(SLUGS);
    expect(prisma.assignment.create).toHaveBeenCalledTimes(1);
    // Intermediate's existing row is untouched.
    expect(rows.find((r) => r.id === 'existing-b')!.batchId).toBe(INTERMEDIATE_ID);
  });

  it('refuses a second Foundation assignment the same day, naming only Foundation — never Intermediate', async () => {
    const { service } = makeService({
      existing: [
        {
          id: 'existing-a',
          dayKey: '2026-08-13',
          batchId: FOUNDATION_ID,
          originalBatchId: FOUNDATION_ID,
          batch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          originalBatch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
      ],
    });

    const attempt = service.create(
      { dayKey: '2026-08-13', batches: ['A'], problemUrls: PROBLEM_URLS },
      'user-1',
    );

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt).rejects.toThrow(/Foundation Level/);
    await expect(attempt).rejects.not.toThrow(/Intermediate/);
  });

  it('allows Foundation and Intermediate to each get their own assignment on the same date', async () => {
    const { service, rows } = makeService();

    await service.create({ dayKey: '2026-08-13', batches: ['A'], problemUrls: PROBLEM_URLS }, 'user-1');
    await service.create({ dayKey: '2026-08-13', batches: ['B'], problemUrls: PROBLEM_URLS }, 'user-1');

    const day = rows.filter((r) => r.dayKey === '2026-08-13');
    expect(day.map((r) => r.batchId).sort()).toEqual([FOUNDATION_ID, INTERMEDIATE_ID].sort());
  });

  it('rejects an unknown batch selector rather than silently widening to "all"', async () => {
    const { service } = makeService();
    await expect(
      service.create({ dayKey: '2026-08-13', batches: ['Z'], problemUrls: PROBLEM_URLS }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AssignmentsService.create — omitted target means every active batch, all-or-nothing', () => {
  it('creates one assignment per active batch when no target is given', async () => {
    const { service, prisma } = makeService();
    const created = await service.create(
      { dayKey: '2026-08-13', problemUrls: PROBLEM_URLS },
      'user-1',
    );
    expect(created).toHaveLength(2);
    expect(created.map((a) => a.batchId).sort()).toEqual([FOUNDATION_ID, INTERMEDIATE_ID].sort());
    expect(prisma.assignment.create).toHaveBeenCalledTimes(2);
  });

  it('excludes an archived batch from "all active batches"', async () => {
    const { service } = makeService({ activeBatchIds: [FOUNDATION_ID] });
    const created = await service.create(
      { dayKey: '2026-08-13', problemUrls: PROBLEM_URLS },
      'user-1',
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.batchId).toBe(FOUNDATION_ID);
  });

  it('writes nothing for either batch when Intermediate alone already has a row that day', async () => {
    const { service, prisma } = makeService({
      existing: [
        {
          id: 'existing-b',
          dayKey: '2026-08-13',
          batchId: INTERMEDIATE_ID,
          originalBatchId: INTERMEDIATE_ID,
          batch: BATCH_DIRECTORY[INTERMEDIATE_ID]!,
          originalBatch: BATCH_DIRECTORY[INTERMEDIATE_ID]!,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
      ],
    });

    await expect(
      service.create({ dayKey: '2026-08-13', problemUrls: PROBLEM_URLS }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing partial was written for Foundation either — genuinely all-or-nothing.
    expect(prisma.assignment.create).not.toHaveBeenCalled();
  });
});

describe('AssignmentsService — legacy "All students" assignments keep working', () => {
  it('a pre-batch (batchId=null) assignment still resolves for a batch with none of its own', async () => {
    const { service } = makeService({
      existing: [
        {
          id: 'legacy',
          dayKey: '2026-07-01',
          batchId: null,
          originalBatchId: null,
          batch: null,
          originalBatch: null,
          audienceChanges: [],
          title: null,
          topic: 'Arrays',
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
      ],
    });

    const forFoundation = await service.findByDay('2026-07-01', FOUNDATION_ID);
    const forIntermediate = await service.findByDay('2026-07-01', INTERMEDIATE_ID);
    expect(forFoundation?.id).toBe('legacy');
    expect(forIntermediate?.id).toBe('legacy');
  });

  it("a batch-specific assignment wins over the legacy row for that batch, but not for the other batch's own row", async () => {
    const { service } = makeService({
      existing: [
        {
          id: 'legacy',
          dayKey: '2026-08-13',
          batchId: null,
          originalBatchId: null,
          batch: null,
          originalBatch: null,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
        {
          id: 'foundation-specific',
          dayKey: '2026-08-13',
          batchId: FOUNDATION_ID,
          originalBatchId: FOUNDATION_ID,
          batch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          originalBatch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
      ],
    });

    const forFoundation = await service.findByDay('2026-08-13', FOUNDATION_ID);
    const forIntermediate = await service.findByDay('2026-08-13', INTERMEDIATE_ID);
    expect(forFoundation?.id).toBe('foundation-specific');
    expect(forIntermediate?.id).toBe('legacy');
  });
});

describe('AssignmentsService.changeTarget — retargeting the audience', () => {
  function existingAll(): FakeAssignment {
    return {
      id: 'legacy-1',
      dayKey: '2026-08-13',
      batchId: null,
      originalBatchId: null,
      batch: null,
      originalBatch: null,
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

  it('moves a legacy "All students" assignment to Foundation only', async () => {
    const { service, prisma } = makeService({ existing: [existingAll()] });

    const result = await service.changeTarget(
      'legacy-1',
      { target: 'A' },
      { id: 'user-1', name: 'Mentor One' },
    );

    expect(result.batchId).toBe(FOUNDATION_ID);
    expect(prisma.assignmentAudienceChange.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignmentId: 'legacy-1',
          fromBatchId: null,
          toBatchId: FOUNDATION_ID,
        }),
      }),
    );
  });

  it('refuses to retarget onto a batch that already has a separate assignment that day', async () => {
    const { service } = makeService({
      existing: [
        existingAll(),
        {
          id: 'foundation-1',
          dayKey: '2026-08-13',
          batchId: FOUNDATION_ID,
          originalBatchId: FOUNDATION_ID,
          batch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          originalBatch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
      ],
    });

    await expect(
      service.changeTarget('legacy-1', { target: 'A' }, { id: 'user-1', name: 'Mentor One' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s for an assignment id that does not exist', async () => {
    const { service } = makeService();
    await expect(
      service.changeTarget('missing', { target: 'A' }, { id: 'user-1', name: 'Mentor One' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AssignmentsService.findAllByDay — every batch\'s own set, side by side', () => {
  it('returns Foundation\'s and Intermediate\'s assignments independently for the same day', async () => {
    const { service } = makeService({
      existing: [
        {
          id: 'a1',
          dayKey: '2026-08-13',
          batchId: FOUNDATION_ID,
          originalBatchId: FOUNDATION_ID,
          batch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          originalBatch: BATCH_DIRECTORY[FOUNDATION_ID]!,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
        {
          id: 'b1',
          dayKey: '2026-08-13',
          batchId: INTERMEDIATE_ID,
          originalBatchId: INTERMEDIATE_ID,
          batch: BATCH_DIRECTORY[INTERMEDIATE_ID]!,
          originalBatch: BATCH_DIRECTORY[INTERMEDIATE_ID]!,
          audienceChanges: [],
          title: null,
          topic: null,
          notes: null,
          difficulty: null,
          createdAt: new Date(),
          createdBy: null,
          problems: [],
        },
      ],
    });

    const all = await service.findAllByDay('2026-08-13');
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.batchId).sort()).toEqual([FOUNDATION_ID, INTERMEDIATE_ID].sort());
  });
});
