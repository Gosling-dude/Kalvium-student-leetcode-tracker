/**
 * Each day's assignment is its own historical record.
 *
 * The brief's scenario, verbatim:
 *
 *   DAY 1: A B C D      DAY 2: E F G H      DAY 3: I J K L
 *
 *   Then modify the current assignment. Verify DAY 1 is still A/B/C/D, DAY 2 still
 *   E/F/G/H, DAY 3 still I/J/K/L.
 *
 * Editing an assignment must reach exactly one day. The failure this guards against is the
 * "assignment configuration" model — one editable list of today's problems that every
 * report reads — under which changing tomorrow's problems silently rewrites what yesterday
 * asked for, and every historical report becomes a report about today.
 *
 * The same problem assigned on two different days is two assignment instances pointing at
 * one `Problem` row, not one shared assignment, so this also checks that re-using a problem
 * on a later day leaves the earlier day alone.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const prisma = new PrismaClient();

const RUN = `e2e-days-${Date.now()}`;
const CODE = `DY${Date.now().toString(36).toUpperCase()}`;

const DAY_1 = '2026-08-20';
const DAY_2 = '2026-08-21';
const DAY_3 = '2026-08-22';

let campusId: string;
/** Letter → problem id, so assertions read like the brief. */
const problems = new Map<string, string>();
const assignments = new Map<string, string>();

async function problemsOn(dayKey: string): Promise<string[]> {
  const rows = await prisma.assignmentProblem.findMany({
    where: { assignment: { dayKey, campusId } },
    orderBy: { position: 'asc' },
    include: { problem: { select: { titleSlug: true } } },
  });
  // Back to the letters, so a failure says "expected A,B,C,D — got A,B,C,Z".
  return rows.map((row) => row.problem.titleSlug.replace(`${RUN}-`, '').toUpperCase());
}

async function assign(dayKey: string, letters: string[]): Promise<string> {
  const assignment = await prisma.assignment.create({
    data: {
      dayKey,
      campusId,
      title: `${RUN} ${dayKey}`,
      problems: {
        create: letters.map((letter, index) => ({
          problemId: problems.get(letter)!,
          position: index + 1,
        })),
      },
    },
  });
  assignments.set(dayKey, assignment.id);
  return assignment.id;
}

beforeAll(async () => {
  const campus = await prisma.campus.create({ data: { name: `${RUN} Campus`, code: CODE } });
  campusId = campus.id;

  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'Z']) {
    const problem = await prisma.problem.create({
      data: {
        titleSlug: `${RUN}-${letter.toLowerCase()}`,
        title: `Problem ${letter}`,
        difficulty: 'EASY',
        url: `https://leetcode.com/problems/${RUN}-${letter.toLowerCase()}/`,
      },
    });
    problems.set(letter, problem.id);
  }

  await assign(DAY_1, ['A', 'B', 'C', 'D']);
  await assign(DAY_2, ['E', 'F', 'G', 'H']);
  await assign(DAY_3, ['I', 'J', 'K', 'L']);
});

afterAll(async () => {
  await prisma.assignmentProblem.deleteMany({
    where: { assignmentId: { in: [...assignments.values()] } },
  });
  await prisma.assignment.deleteMany({ where: { id: { in: [...assignments.values()] } } });
  await prisma.problem.deleteMany({ where: { id: { in: [...problems.values()] } } });
  await prisma.campus.deleteMany({ where: { id: campusId } });
  await prisma.$disconnect();
});

describe('three consecutive days keep their own problem sets', () => {
  it('stores each day separately', async () => {
    expect(await problemsOn(DAY_1)).toEqual(['A', 'B', 'C', 'D']);
    expect(await problemsOn(DAY_2)).toEqual(['E', 'F', 'G', 'H']);
    expect(await problemsOn(DAY_3)).toEqual(['I', 'J', 'K', 'L']);
  });

  it('leaves the earlier days untouched when the latest day is rewritten', async () => {
    // Exactly the edit that would corrupt history under a single "current assignment".
    const dayThree = assignments.get(DAY_3)!;
    await prisma.$transaction([
      prisma.assignmentProblem.deleteMany({ where: { assignmentId: dayThree } }),
      prisma.assignmentProblem.createMany({
        data: [
          { assignmentId: dayThree, problemId: problems.get('Z')!, position: 1 },
          { assignmentId: dayThree, problemId: problems.get('A')!, position: 2 },
        ],
      }),
    ]);

    expect(await problemsOn(DAY_1)).toEqual(['A', 'B', 'C', 'D']);
    expect(await problemsOn(DAY_2)).toEqual(['E', 'F', 'G', 'H']);
    expect(await problemsOn(DAY_3)).toEqual(['Z', 'A']);
  });

  it('treats the same problem on two days as two instances of one problem', async () => {
    // Problem A now appears on day 1 and day 3. One `Problem` row, two assignment links —
    // so day 3 borrowing it did not move it off day 1.
    const links = await prisma.assignmentProblem.findMany({
      where: { problemId: problems.get('A')!, assignment: { campusId } },
      include: { assignment: { select: { dayKey: true } } },
    });

    expect(links.map((l) => l.assignment.dayKey).sort()).toEqual([DAY_1, DAY_3]);
    expect(new Set(links.map((l) => l.problemId)).size).toBe(1);
  });

  it('lets a day carry a different number of problems — nothing is fixed at four', async () => {
    // Day 3 now has 2. The count is whatever that day assigned, never a constant.
    expect(await problemsOn(DAY_3)).toHaveLength(2);
    expect(await problemsOn(DAY_1)).toHaveLength(4);
  });

  it('keeps every assignment addressable by its own id and date', async () => {
    const rows = await prisma.assignment.findMany({
      where: { campusId },
      select: { id: true, dayKey: true, createdAt: true },
      orderBy: { dayKey: 'asc' },
    });

    expect(rows.map((r) => r.dayKey)).toEqual([DAY_1, DAY_2, DAY_3]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    for (const row of rows) expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('reports nothing for a date that was never assigned', async () => {
    // The "No assignment data available for this date" case — an absence, not a zero.
    const future = await prisma.assignment.findMany({ where: { dayKey: '2027-01-01', campusId } });
    expect(future).toHaveLength(0);
  });
});
