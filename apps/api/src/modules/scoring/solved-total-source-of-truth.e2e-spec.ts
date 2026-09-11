/**
 * "Total questions solved so far" — one definition, every surface, against a real database.
 *
 * The reported symptom was that the figure disagreed between screens. It had two causes,
 * and they pull in opposite directions:
 *
 *  - **Staleness.** `Student.totalSolved` is a cache the nightly rollup refreshes. The
 *    directory read the column; the student page computed it live. Same definition,
 *    different ages, two numbers.
 *  - **Double counting.** The programme reuses problems across assignments, so any figure
 *    summed over assignment days reports one solved problem once per assignment that ever
 *    contained it — 40 distinct problems reading as 200.
 *
 * The definition asserted here is the one the programme asked for: **distinct LeetCode
 * problems with a verified accepted solution**. Not submissions, not per-assignment rows,
 * not the same problem counted once per assignment.
 *
 * The last group is the one that matters most: an unreadable profile must never become a
 * zero. A student we hold no evidence for keeps the last figure we knew rather than being
 * silently reported as having solved nothing.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StudentMetricsService } from './student-metrics.service';
import { ScoringConfigService } from './scoring-config.service';
import { StudentsService } from '../students/students.service';
import { BatchesService } from '../batches/batches.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { StudentQueryDto } from '../students/dto/student.dto';

const prisma = new PrismaClient();

const RUN = `e2e-total-${Date.now()}`;
const CODE = `TT${Date.now().toString(36).toUpperCase()}`;
const IST = '+05:30';
const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${IST}`);

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const noCache = {
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  delByPrefix: async () => undefined,
} as never;
const scoringConfig = new ScoringConfigService(prisma as never);
const batches = new BatchesService(prisma as never, time, noCache);
const metrics = new StudentMetricsService(prisma as never, time, scoringConfig, batches);
const students = new StudentsService(prisma as never, time, metrics, batches);

let campusId: string;
let batchId: string;
const studentIds: Record<string, string> = {};
const problemIds: string[] = [];
const assignmentIds: string[] = [];

function query(over: Partial<StudentQueryDto> = {}): StudentQueryDto {
  const page = over.page ?? 1;
  const pageSize = over.pageSize ?? 50;
  return {
    page,
    pageSize,
    sortOrder: over.sortOrder ?? 'asc',
    get skip() {
      return (page - 1) * pageSize;
    },
    get take() {
      return pageSize;
    },
    ...over,
  } as StudentQueryDto;
}

async function makeStudent(key: string, storedTotal: number): Promise<string> {
  const row = await prisma.student.create({
    data: {
      name: `${RUN} ${key}`,
      email: `${RUN}-${key}@total.invalid`,
      leetcodeUsername: `${RUN}-${key}`,
      campusId,
      batchId,
      status: 'ACTIVE',
      // Deliberately wrong, so a surface that reads the cache rather than the canonical
      // calculation is visible rather than merely possible.
      totalSolved: storedTotal,
      createdAt: ist('2099-06-01', '09:00'),
    },
  });
  studentIds[key] = row.id;
  return row.id;
}

async function submit(
  studentId: string,
  slug: string,
  day: string,
  hhmm: string,
  status: 'ACCEPTED' | 'ATTEMPTED_NOT_ACCEPTED' = 'ACCEPTED',
  seq = 1,
): Promise<void> {
  const problem = await prisma.problem.findUnique({ where: { titleSlug: slug } });
  await prisma.submission.create({
    data: {
      studentId,
      problemId: problem?.id ?? null,
      providerSubmissionId: `${RUN}-${studentId}-${slug}-${seq}`,
      titleSlug: slug,
      title: slug.toUpperCase(),
      status,
      submittedAt: ist(day, hhmm),
      dayKey: day,
    },
  });
}

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;
  const batch = await prisma.batch.create({
    data: { name: `${RUN} Foundation`, code: 'A', campusId },
  });
  batchId = batch.id;

  // Three tracked problems, plus one the programme never assigned.
  const slugs = [`${RUN}-p1`, `${RUN}-p2`, `${RUN}-p3`, `${RUN}-untracked`].map((s) =>
    s.toLowerCase(),
  );
  for (const slug of slugs) {
    const problem = await prisma.problem.create({
      data: {
        titleSlug: slug,
        title: slug.toUpperCase(),
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${slug}/`,
      },
    });
    problemIds.push(problem.id);
  }

  await makeStudent('repeater', 999);
  await makeStudent('noEvidence', 137);
  await makeStudent('zeroButSynced', 0);

  // `repeater`: three distinct problems, one of them submitted many times, plus a problem
  // attempted and never accepted. Distinct accepted = 3.
  for (let i = 1; i <= 20; i += 1) {
    await submit(studentIds.repeater!, slugs[0]!, '2099-07-01', '10:00', 'ACCEPTED', i);
  }
  await submit(studentIds.repeater!, slugs[1]!, '2099-07-02', '10:00', 'ACCEPTED', 100);
  await submit(studentIds.repeater!, slugs[3]!, '2099-07-03', '10:00', 'ACCEPTED', 101);
  await submit(
    studentIds.repeater!,
    slugs[2]!,
    '2099-07-04',
    '10:00',
    'ATTEMPTED_NOT_ACCEPTED',
    102,
  );

  // `zeroButSynced`: a successful read that found nothing. A genuine zero, and the
  // provider profile says so — which is what distinguishes it from `noEvidence`.
  await prisma.studentSyncState.create({
    data: {
      studentId: studentIds.zeroButSynced!,
      status: 'OK',
      lastSyncedAt: ist('2099-07-05', '08:00'),
      providerTotalSolved: 0,
    },
  });

  // `noEvidence`: never successfully read. No submissions, no provider total.
  await prisma.studentSyncState.create({
    data: { studentId: studentIds.noEvidence!, status: 'PROFILE_PRIVATE' },
  });

  // The same problem placed in five different assignments, all solved by `repeater` once.
  for (let i = 0; i < 5; i += 1) {
    const day = `2099-07-1${i}`;
    const assignment = await prisma.assignment.create({
      data: {
        dayKey: day,
        campusId,
        batchId,
        originalCampusId: campusId,
        originalBatchId: batchId,
        title: `${RUN} repeat ${i}`,
        problems: { create: [{ problemId: problemIds[0]!, position: 1 }] },
      },
    });
    assignmentIds.push(assignment.id);

    const status = await prisma.dailyStatus.create({
      data: {
        studentId: studentIds.repeater!,
        dayKey: day,
        assignmentId: assignment.id,
        campusId,
        batchId,
        assignedCount: 1,
        solvedCount: 1,
        inWindowSolvedCount: 1,
      },
    });
    await prisma.dailyProblemStatus.create({
      data: {
        dailyStatusId: status.id,
        problemId: problemIds[0]!,
        position: 1,
        status: 'ACCEPTED',
        inWindowStatus: 'ACCEPTED',
        solvedAt: ist('2099-07-01', '10:00'),
      },
    });
  }
});

afterAll(async () => {
  const ids = Object.values(studentIds);
  await prisma.dailyProblemStatus.deleteMany({
    where: { dailyStatus: { studentId: { in: ids } } },
  });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.submission.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.studentSyncState.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId: { in: assignmentIds } } });
  await prisma.assignment.deleteMany({ where: { id: { in: assignmentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.batch.deleteMany({ where: { campusId } });
  await prisma.campus.delete({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('the canonical total counts distinct accepted problems', () => {
  it('counts twenty accepted submissions to one problem once', async () => {
    const total = await metrics.calculateStudentLeetcodeTotalSolved(studentIds.repeater!);
    // p1 (x20), p2, untracked. p3 was attempted and never accepted.
    expect(total).toBe(3);
  });

  it('does not count a problem once per assignment that contained it', async () => {
    // Five assignments, five DailyStatus rows, one problem. Summing the rows would say 5.
    const dailyRows = await prisma.dailyStatus.aggregate({
      where: { studentId: studentIds.repeater! },
      _sum: { solvedCount: true },
    });
    expect(dailyRows._sum.solvedCount).toBe(5);

    // The programme-specific metric counts the problem, not the rows.
    expect(await metrics.distinctAssignmentProblemsSolved(studentIds.repeater!)).toBe(1);
    // And the lifetime figure is unmoved by how often the problem was assigned.
    expect(await metrics.calculateStudentLeetcodeTotalSolved(studentIds.repeater!)).toBe(3);
  });

  it('excludes problems attempted but never accepted', async () => {
    const rows = await prisma.submission.count({
      where: { studentId: studentIds.repeater!, status: 'ATTEMPTED_NOT_ACCEPTED' },
    });
    expect(rows).toBe(1);
    expect(await metrics.calculateStudentLeetcodeTotalSolved(studentIds.repeater!)).toBe(3);
  });
});

describe('every surface reports the same total', () => {
  it('the directory row matches the canonical calculation, not the stale column', async () => {
    const stored = await prisma.student.findUniqueOrThrow({
      where: { id: studentIds.repeater! },
      select: { totalSolved: true },
    });
    expect(stored.totalSolved).toBe(999); // the cache is deliberately wrong

    const page = await students.findAll(query({ campusId, search: RUN }));
    const row = page.items.find((item) => item.id === studentIds.repeater!)!;
    expect(row.totalSolved).toBe(3);
  });

  it('the single-student fetch agrees with the directory row', async () => {
    const one = await students.findOne(studentIds.repeater!);
    const page = await students.findAll(query({ campusId, search: RUN }));
    const row = page.items.find((item) => item.id === studentIds.repeater!)!;

    expect(one.totalSolved).toBe(row.totalSolved);
    expect(one.totalSolved).toBe(3);
  });
});

describe('reconciliation repairs drift without inventing zeroes', () => {
  it('corrects a stored total that disagrees with the canonical one', async () => {
    const result = await metrics.reconcileStoredTotals(Object.values(studentIds));

    const repaired = result.corrected.find((row) => row.studentId === studentIds.repeater!);
    expect(repaired).toMatchObject({ before: 999, after: 3 });

    const stored = await prisma.student.findUniqueOrThrow({
      where: { id: studentIds.repeater! },
      select: { totalSolved: true },
    });
    expect(stored.totalSolved).toBe(3);
  });

  it('leaves a student we hold no evidence for untouched, rather than zeroing them', async () => {
    // A private profile is not a student who has solved nothing. This is the
    // "DATA_UNAVAILABLE must never become 0" rule, at the storage layer.
    const result = await metrics.reconcileStoredTotals(Object.values(studentIds));
    expect(result.corrected.some((row) => row.studentId === studentIds.noEvidence!)).toBe(false);
    expect(result.skippedNoEvidence).toBeGreaterThanOrEqual(1);

    const stored = await prisma.student.findUniqueOrThrow({
      where: { id: studentIds.noEvidence! },
      select: { totalSolved: true },
    });
    expect(stored.totalSolved).toBe(137);
  });

  it('still reports a genuine zero as zero', async () => {
    // The distinction the previous test depends on: a successful read that found nothing
    // *is* evidence, and must not be confused with never having read at all.
    expect(await metrics.calculateStudentLeetcodeTotalSolved(studentIds.zeroButSynced!)).toBe(0);

    const one = await students.findOne(studentIds.zeroButSynced!);
    expect(one.totalSolved).toBe(0);
  });

  it('is idempotent — a second run corrects nothing', async () => {
    await metrics.reconcileStoredTotals(Object.values(studentIds));
    const second = await metrics.reconcileStoredTotals(Object.values(studentIds));
    expect(second.corrected).toEqual([]);
  });
});
