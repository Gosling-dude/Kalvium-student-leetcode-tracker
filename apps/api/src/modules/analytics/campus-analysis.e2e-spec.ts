/**
 * Campus analysis against a real database: scope, and the one invariant the feature is
 * built around.
 *
 * The invariant: **a category card's number and the list behind it are the same query.**
 * The workbook this replaces had a summary sheet and a detail sheet produced by separate
 * passes, and they disagreed. Here the count and the drill-down both come from
 * `weeklyRowsFor`, and the test that matters asserts they still do — not by inspecting
 * the code, but by comparing every card against the list it opens.
 *
 * Scope is asserted the way it can actually fail: a mentor granted one campus asking for
 * another's, directly, by id.
 *
 * Fixtures live under a unique prefix and are removed in `afterAll`.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAMPUS_CATEGORIES } from '@dsa/shared';

import { CampusAnalysisService } from './campus-analysis.service';
import { MentorScopeService } from '../campuses/mentor-scope.service';
import { ProgramTimeService } from '../../common/services/program-time.service';
import type { RequestUser } from '../../common/decorators';

const prisma = new PrismaClient();
const RUN = `e2e-ca-${Date.now()}`;
const STAMP = Date.now().toString(36).toUpperCase();
const IST = '+05:30';

/** A period in a year the programme will never hold real data for. */
const FROM = '2099-08-03'; // a Monday
const TO = '2099-09-13';
const ENROLLED = '2099-07-01';

const ist = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00${IST}`);

const time = new ProgramTimeService({ program: { timezone: 'Asia/Kolkata' } } as never);
const scope = new MentorScopeService(prisma as never);
const service = new CampusAnalysisService(prisma as never, time, scope);

const admin: RequestUser = { id: '', email: 'a@x.invalid', name: 'Admin', role: 'ADMIN', studentId: null } as RequestUser;
let mentorOfA: RequestUser;
let campusA: string;
let campusB: string;
const studentIds: Record<string, string> = {};
const problemIds: string[] = [];
const assignmentIds: string[] = [];
const userIds: string[] = [];

/** Assignment days, one per week, so every week carries exactly two questions. */
const DAYS = ['2099-08-05', '2099-08-12', '2099-08-19', '2099-08-26', '2099-09-02', '2099-09-09'];

async function makeCampus(code: string, name: string): Promise<string> {
  return (await prisma.campus.create({ data: { code, name: `${RUN} ${name}` } })).id;
}

async function makeStudent(
  key: string,
  campusId: string,
  batchId: string,
  options: { syncStatus?: string; handle?: string | null } = {},
): Promise<string> {
  const row = await prisma.student.create({
    data: {
      name: `${RUN} ${key}`,
      email: `${RUN}-${key}@ca.invalid`,
      leetcodeUsername: options.handle === undefined ? `${RUN}-${key}` : options.handle,
      campusId,
      batchId,
      status: 'ACTIVE',
      createdAt: ist(ENROLLED, '09:00'),
      campusHistory: { create: { toCampusId: campusId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' } },
      batchHistory: { create: { toBatchId: batchId, effectiveFromDayKey: ENROLLED, source: 'MIGRATION' } },
      syncState: { create: { status: (options.syncStatus ?? 'OK') as never, lastSyncedAt: ist(TO, '08:00') } },
    },
  });
  studentIds[key] = row.id;
  return row.id;
}

/**
 * Write the scored day directly: this suite tests the reading, not the rollup.
 *
 * Both levels are written, because the two summaries read different rows and a fixture
 * that sets only one cannot tell a correct reading from a broken one: the day-level
 * `solvedCount` feeds the student categories, the per-problem rows feed the question
 * counts. The rollup always writes them together, so a fixture that does not is testing
 * a state production never has.
 */
async function scoreDay(studentId: string, dayKey: string, assignmentId: string, solved: number): Promise<void> {
  const status = await prisma.dailyStatus.create({
    data: {
      studentId,
      dayKey,
      assignmentId,
      assignedCount: 2,
      solvedCount: solved,
      inWindowSolvedCount: 0,
      computedVersion: 2,
    },
  });
  const links = await prisma.assignmentProblem.findMany({
    where: { assignmentId },
    orderBy: { position: 'asc' },
  });
  await prisma.dailyProblemStatus.createMany({
    data: links.map((link, i) => ({
      dailyStatusId: status.id,
      problemId: link.problemId,
      position: link.position,
      status: i < solved ? ('ACCEPTED' as const) : ('NOT_ATTEMPTED' as const),
    })),
  });
}

beforeAll(async () => {
  campusA = await makeCampus(`CA${STAMP}`.slice(0, 10), 'Campus A');
  campusB = await makeCampus(`CB${STAMP}`.slice(0, 10), 'Campus B');
  const batchA = (await prisma.batch.create({ data: { name: `${RUN} A`, code: 'A', campusId: campusA } })).id;
  const batchB = (await prisma.batch.create({ data: { name: `${RUN} B`, code: 'A', campusId: campusB } })).id;

  for (const day of DAYS) {
    const problems = [];
    for (const n of [1, 2]) {
      const slug = `${RUN}-${day}-${n}`.toLowerCase();
      const problem = await prisma.problem.create({
        data: { titleSlug: slug, title: slug, difficulty: 'EASY', url: `https://leetcode.com/problems/${slug}/` },
      });
      problemIds.push(problem.id);
      problems.push(problem);
    }
    const assignment = await prisma.assignment.create({
      data: {
        dayKey: day,
        campusId: campusA,
        batchId: batchA,
        originalCampusId: campusA,
        originalBatchId: batchA,
        title: `${RUN} ${day}`,
        problems: { create: problems.map((p, i) => ({ problemId: p.id, position: i + 1 })) },
      },
    });
    assignmentIds.push(assignment.id);
  }

  // Campus A: one of each shape the categories are meant to separate.
  await makeStudent('strong', campusA, batchA);
  await makeStudent('silent', campusA, batchA);
  await makeStudent('unreadable', campusA, batchA, { syncStatus: 'PROFILE_PRIVATE' });
  await makeStudent('nohandle', campusA, batchA, { handle: null });
  // Campus B has a student too, so a leak would have something to leak.
  await makeStudent('otherCampus', campusB, batchB);

  for (const [i, day] of DAYS.entries()) {
    await scoreDay(studentIds.strong!, day, assignmentIds[i]!, 2);
    await scoreDay(studentIds.silent!, day, assignmentIds[i]!, 0);
    await scoreDay(studentIds.unreadable!, day, assignmentIds[i]!, 0);
    await scoreDay(studentIds.nohandle!, day, assignmentIds[i]!, 0);
  }

  const mentor = await prisma.user.create({
    data: {
      email: `${RUN}-mentor@ca.invalid`,
      name: `${RUN} mentor`,
      role: 'MENTOR',
      passwordHash: 'x',
      mentorCampuses: { create: { campusId: campusA } },
    },
  });
  userIds.push(mentor.id);
  mentorOfA = { id: mentor.id, email: mentor.email, name: mentor.name, role: 'MENTOR', studentId: null } as RequestUser;
});

afterAll(async () => {
  const ids = Object.values(studentIds);
  await prisma.dailyProblemStatus.deleteMany({ where: { dailyStatus: { studentId: { in: ids } } } });
  await prisma.dailyStatus.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.assignmentProblem.deleteMany({ where: { assignmentId: { in: assignmentIds } } });
  await prisma.assignment.deleteMany({ where: { id: { in: assignmentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.problem.deleteMany({ where: { id: { in: problemIds } } });
  await prisma.mentorCampus.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.batch.deleteMany({ where: { campusId: { in: [campusA, campusB] } } });
  await prisma.campus.deleteMany({ where: { id: { in: [campusA, campusB] } } });
  await prisma.$disconnect();
});

const period = { from: FROM, to: TO };
const campusOf = <T extends { campusId: string }>(result: { campuses: T[] }, id: string): T => {
  const campus = result.campuses.find((c) => c.campusId === id);
  if (!campus) throw new Error(`campus ${id} missing from the summary`);
  return campus;
};

describe('campus analysis', () => {
  it('places each student by the rules the reference sheet states', async () => {
    const result = await service.summary(admin, { ...period, campusId: campusA });
    const counts = Object.fromEntries(
      campusOf(result, campusA).categories.map((c) => [c.category, c.students]),
    );
    expect(counts.CONSISTENT_SOLVER).toBe(1); // 'strong' solved both, every week
    expect(counts.NOT_PARTICIPATING).toBe(1); // 'silent' solved none, and we can read them
    expect(counts.DATA_UNAVAILABLE).toBe(2); // 'unreadable' and 'nohandle'
  });

  it('never reports an unreadable student as one who solved nothing', async () => {
    const notParticipating = await service.drillDown(admin, campusA, 'NOT_PARTICIPATING', period);
    const unavailable = await service.drillDown(admin, campusA, 'DATA_UNAVAILABLE', period);

    const names = (r: { students: { studentId: string }[] }) => r.students.map((s) => s.studentId);
    // Identical stored rows — all zeros — and they are not given the same verdict.
    expect(names(notParticipating)).toEqual([studentIds.silent]);
    expect(names(unavailable).sort()).toEqual([studentIds.unreadable, studentIds.nohandle].sort());
    for (const student of unavailable.students) {
      expect(student.dataAvailable).toBe(false);
      expect(student.dataIssue).toBeTruthy();
    }
  });

  describe('every card reconciles with the list it opens', () => {
    it('for every category, on every campus the caller can see', async () => {
      const result = await service.summary(admin, period);
      for (const campus of result.campuses) {
        for (const card of campus.categories) {
          const detail = await service.drillDown(admin, campus.campusId, card.category, period);
          expect(
            detail.students.length,
            `${campus.campusCode} / ${card.category}: card says ${card.students}, list has ${detail.students.length}`,
          ).toBe(card.students);
        }
      }
    });

    it('and the campus totals are questions, deliberately not the sum of its students', async () => {
      const result = await service.summary(admin, { ...period, campusId: campusA });
      const campus = campusOf(result, campusA);

      let studentAssigned = 0;
      for (const category of CAMPUS_CATEGORIES) {
        for (const student of (await service.drillDown(admin, campusA, category, period)).students) {
          studentAssigned += student.assigned;
        }
      }

      // Six days, two problems each: twelve distinct questions, whatever the cohort size.
      expect(campus.assigned).toBe(DAYS.length * 2);
      // The student sum is four times larger here, and would grow with every enrolment.
      // Asserting they differ is the regression guard: this is the exact substitution
      // that put "1,960 questions assigned" in front of a manager.
      expect(studentAssigned).toBeGreaterThan(campus.assigned);

      // The question drill-down is the thing that must agree with the card.
      const detail = await service.questions(admin, campusA, period);
      expect(detail.questions.length).toBe(campus.assigned);
      expect(detail.totals.solved).toBe(campus.solved);
    });
  });

  describe('scope', () => {
    it('gives an admin every campus', async () => {
      const result = await service.summary(admin, period);
      expect(result.campuses.map((c) => c.campusId)).toEqual(expect.arrayContaining([campusA, campusB]));
    });

    it('gives a mentor only their grants', async () => {
      const result = await service.summary(mentorOfA, period);
      expect(result.campuses.map((c) => c.campusId)).toContain(campusA);
      expect(result.campuses.map((c) => c.campusId)).not.toContain(campusB);
    });

    it('refuses a mentor who asks for another campus by id, on the summary', async () => {
      await expect(service.summary(mentorOfA, { ...period, campusId: campusB })).rejects.toThrow();
    });

    it('refuses a mentor who asks for another campus by id, on the drill-down', async () => {
      await expect(service.drillDown(mentorOfA, campusB, 'NOT_PARTICIPATING', period)).rejects.toThrow();
    });

    it('refuses a mentor reading a student outside their campuses', async () => {
      await expect(service.studentDetail(mentorOfA, studentIds.otherCampus!, period)).rejects.toThrow();
    });

    it('lets a student read themselves and nobody else', async () => {
      const self = {
        id: 'u', email: 's@x.invalid', name: 's', role: 'STUDENT', studentId: studentIds.strong,
      } as RequestUser;
      const own = await service.studentDetail(self, studentIds.strong!, period);
      expect(own.student.studentId).toBe(studentIds.strong);
      await expect(service.studentDetail(self, studentIds.silent!, period)).rejects.toThrow();
    });

    it('does not let one campus’s students into another campus’s totals', async () => {
      const result = await service.summary(admin, period);
      expect(campusOf(result, campusA).activeStudents).toBe(4);
      expect(campusOf(result, campusB).activeStudents).toBe(1);
    });
  });

  it('shows the evidence for a solve that predates its assignment', async () => {
    const detail = await service.studentDetail(admin, studentIds.strong!, period);
    expect(detail.student.solved).toBe(12);
    expect(detail.days.length).toBe(DAYS.length);
  });
});
