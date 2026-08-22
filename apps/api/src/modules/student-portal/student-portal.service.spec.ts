/**
 * `StudentPortalService` — the properties worth protecting are all data-isolation ones
 * (§9, §19):
 *
 *  - Every method resolves identity from `RequestUser.studentId`, never a parameter, and
 *    refuses an account with no linked student rather than querying with `undefined`.
 *  - An assignment targeted at a batch the caller is not in reads as 404, identically to
 *    a made-up id — a student cannot distinguish "wrong id" from "not your batch".
 *  - `profile()` never returns `notes` (mentor-only observations), regardless of what
 *    `StudentsService.getProfile` includes.
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StudentPortalService } from './student-portal.service';
import type { RequestUser } from '../../common/decorators';

const STUDENT_USER: RequestUser = {
  id: 'user-1',
  email: 's@kalvium.community',
  name: 'Student One',
  role: 'STUDENT',
  studentId: 'student-1',
};

const NO_STUDENT_USER: RequestUser = {
  id: 'user-2',
  email: 'admin@kalvium.com',
  name: 'Admin',
  role: 'ADMIN',
  studentId: null,
};

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'student-1',
    name: 'Student One',
    batchId: 'batch-b',
    batchName: 'Intermediate Level',
    batchCode: 'B',
    heatmap: [],
    recentDays: [],
    weeklyCompletionPercent: 0,
    monthlyCompletionPercent: 0,
    notes: [{ id: 'n1', body: 'A private mentor observation', authorId: 'm1', authorName: 'Mentor', createdAt: '', updatedAt: '' }],
    ...overrides,
  };
}

function makeService() {
  const prisma = {
    dailyStatus: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const time = {
    today: vi.fn().mockReturnValue('2026-08-13'),
    weekBounds: vi.fn().mockReturnValue({ from: '2026-08-10', to: '2026-08-16' }),
    monthBounds: vi.fn().mockReturnValue({ from: '2026-08-01', to: '2026-08-31' }),
  };
  const students = {
    findOne: vi
      .fn()
      .mockResolvedValue({ id: 'student-1', campusId: 'campus-srm', batchId: 'batch-b' }),
    getProfile: vi.fn().mockResolvedValue(makeProfile()),
  };
  const assignments = {
    findByDay: vi.fn().mockResolvedValue(null),
    findAll: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }),
    findById: vi.fn(),
  };
  const leaderboard = {
    myRank: vi.fn().mockResolvedValue(null),
    getLeaderboard: vi.fn().mockResolvedValue([]),
  };

  const service = new StudentPortalService(
    prisma as never,
    time as never,
    students as never,
    assignments as never,
    leaderboard as never,
  );
  return { service, prisma, time, students, assignments, leaderboard };
}

describe('StudentPortalService — identity resolution', () => {
  it('refuses an account with no linked student, before any query runs', async () => {
    const { service, students } = makeService();
    await expect(service.me(NO_STUDENT_USER)).rejects.toThrow(ForbiddenException);
    expect(students.findOne).not.toHaveBeenCalled();
  });

  it('resolves the caller from the session, never a parameter', async () => {
    const { service, students } = makeService();
    await service.me(STUDENT_USER);
    expect(students.findOne).toHaveBeenCalledWith('student-1');
  });
});

describe('StudentPortalService.profile — never leaks mentor notes', () => {
  it('strips notes even though the underlying profile carries them', async () => {
    const { service } = makeService();
    const profile = await service.profile(STUDENT_USER);
    expect(profile).not.toHaveProperty('notes');
  });
});

describe('StudentPortalService.assignmentDetail — campus and batch isolation', () => {
  it('returns the assignment when it targets the caller\'s own campus and batch', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue({
      id: 'a1',
      dayKey: '2026-08-13',
      campusId: 'campus-srm',
      batchId: 'batch-b',
      batchName: 'Intermediate Level',
      batchCode: 'B',
      title: 'Sliding Window',
      topic: null,
      difficulty: null,
      problems: [],
    });

    const result = await service.assignmentDetail(STUDENT_USER, 'a1');
    expect(result.id).toBe('a1');
  });

  it('returns the assignment when it is untargeted (applies to every batch)', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue({
      id: 'a1',
      dayKey: '2026-08-13',
      campusId: null,
      batchId: null,
      batchName: null,
      batchCode: null,
      title: 'Legacy day',
      topic: null,
      difficulty: null,
      problems: [],
    });

    const result = await service.assignmentDetail(STUDENT_USER, 'a1');
    expect(result.id).toBe('a1');
  });

  it('404s — not 403, not the assignment — when it targets a different batch', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue({
      id: 'a1',
      dayKey: '2026-08-13',
      campusId: 'campus-srm',
      batchId: 'batch-a', // Foundation; the caller is in Intermediate (batch-b)
      batchName: 'Foundation Level',
      batchCode: 'A',
      title: 'Not yours',
      topic: null,
      difficulty: null,
      problems: [],
    });

    await expect(service.assignmentDetail(STUDENT_USER, 'a1')).rejects.toThrow(NotFoundException);
  });

  /**
   * The cross-campus case, and the reason it is a 404 rather than a 403.
   *
   * A 403 would confirm the assignment exists. Repeated over a range of ids that turns
   * the endpoint into a way to enumerate what another campus was set — so "not yours"
   * and "no such thing" must be indistinguishable (§40).
   */
  it('404s when the assignment belongs to another campus, even at the same batch level', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue({
      id: 'a1',
      dayKey: '2026-08-13',
      campusId: 'campus-vels', // caller is at SRM
      batchId: 'batch-vels-b',
      batchName: 'Intermediate Level',
      batchCode: 'B',
      title: "Vels' problems",
      topic: null,
      difficulty: null,
      problems: [],
    });

    await expect(service.assignmentDetail(STUDENT_USER, 'a1')).rejects.toThrow(NotFoundException);
  });

  it('404s for a whole-campus assignment belonging to another campus', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue({
      id: 'a1',
      dayKey: '2026-08-13',
      campusId: 'campus-vels',
      batchId: null,
      batchName: null,
      batchCode: null,
      title: 'All of Vels',
      topic: null,
      difficulty: null,
      problems: [],
    });

    await expect(service.assignmentDetail(STUDENT_USER, 'a1')).rejects.toThrow(NotFoundException);
  });

  it('404s identically for an id that does not exist at all', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue(null);
    await expect(service.assignmentDetail(STUDENT_USER, 'missing')).rejects.toThrow(NotFoundException);
  });
});

describe("StudentPortalService.assignmentHistory — scoped to the caller's own audience", () => {
  it("passes the caller's own campus and batch, never a client-supplied one", async () => {
    const { service, assignments } = makeService();
    await service.assignmentHistory(STUDENT_USER, { page: 1, pageSize: 20 } as never);
    expect(assignments.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { campusId: 'campus-srm', batchId: 'batch-b' },
      }),
    );
  });
});

describe('StudentPortalService.myLeaderboard — a student cannot name someone else’s scope', () => {
  it('scopes to the caller’s own campus by default', async () => {
    const { service, leaderboard } = makeService();
    await service.myLeaderboard(STUDENT_USER, { period: 'WEEKLY', scope: 'campus' } as never);
    expect(leaderboard.getLeaderboard).toHaveBeenCalledWith(
      'WEEKLY',
      undefined,
      expect.objectContaining({ campusId: 'campus-srm', batchId: undefined }),
    );
  });

  it('narrows to the caller’s own batch for "mine"', async () => {
    const { service, leaderboard } = makeService();
    await service.myLeaderboard(STUDENT_USER, { period: 'WEEKLY', scope: 'mine' } as never);
    expect(leaderboard.getLeaderboard).toHaveBeenCalledWith(
      'WEEKLY',
      undefined,
      expect.objectContaining({ campusId: 'campus-srm', batchId: 'batch-b' }),
    );
  });

  it('drops every scope filter for the global board, which students may see', async () => {
    const { service, leaderboard } = makeService();
    await service.myLeaderboard(STUDENT_USER, { period: 'WEEKLY', scope: 'global' } as never);
    expect(leaderboard.getLeaderboard).toHaveBeenCalledWith(
      'WEEKLY',
      undefined,
      expect.objectContaining({ campusId: undefined, batchId: undefined }),
    );
  });
});

/**
 * §submission-attempt-tracking: a student may see their own solved / attempted-not-solved
 * / not-attempted breakdown, and never anyone else's.
 */
describe("StudentPortalService.assignmentDetail — this student's own attempt breakdown", () => {
  const ASSIGNMENT = {
    id: 'a1',
    dayKey: '2026-08-10',
    campusId: 'campus-srm',
    batchId: 'batch-b',
    batchName: 'Intermediate Level',
    batchCode: 'B',
    title: 'Sliding Window',
    topic: null,
    difficulty: null,
    problems: [
      { problemId: 'p1', position: 1, title: 'Problem 1', titleSlug: 'p1', url: 'https://x/1', difficulty: 'EASY' },
      { problemId: 'p2', position: 2, title: 'Problem 2', titleSlug: 'p2', url: 'https://x/2', difficulty: 'EASY' },
      { problemId: 'p3', position: 3, title: 'Problem 3', titleSlug: 'p3', url: 'https://x/3', difficulty: 'EASY' },
      { problemId: 'p4', position: 4, title: 'Problem 4', titleSlug: 'p4', url: 'https://x/4', difficulty: 'EASY' },
    ],
  };

  it('reads the accepted / attempted-not-accepted / not-attempted status straight from DailyProblemStatus, per problem', async () => {
    const { service, assignments, prisma } = makeService();
    assignments.findById.mockResolvedValue(ASSIGNMENT);
    prisma.dailyStatus.findUnique.mockResolvedValue({
      solvedCount: 1,
      assignedCount: 4,
      isPerfect: false,
      completedAt: null,
      problemStatuses: [
        { problemId: 'p1', status: 'ACCEPTED', solvedAt: new Date('2026-08-10T10:00:00Z') },
        { problemId: 'p2', status: 'ATTEMPTED_NOT_ACCEPTED', solvedAt: null },
        // p3 and p4 have no row at all — never submitted.
      ],
    });

    const result = await service.assignmentDetail(STUDENT_USER, 'a1');

    expect(result.myOutcome?.problems).toEqual([
      expect.objectContaining({ problemId: 'p1', status: 'ACCEPTED' }),
      expect.objectContaining({ problemId: 'p2', status: 'ATTEMPTED_NOT_ACCEPTED' }),
      expect.objectContaining({ problemId: 'p3', status: 'NOT_ATTEMPTED' }),
      expect.objectContaining({ problemId: 'p4', status: 'NOT_ATTEMPTED' }),
    ]);
  });

  it("always queries the caller's own studentId, never one implied by the assignment or any other input", async () => {
    const { service, assignments, prisma } = makeService();
    assignments.findById.mockResolvedValue(ASSIGNMENT);

    await service.assignmentDetail(STUDENT_USER, 'a1');

    expect(prisma.dailyStatus.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId_dayKey: { studentId: 'student-1', dayKey: '2026-08-10' } },
      }),
    );
  });

  it('a different student session sees only their own outcome for the same assignment id', async () => {
    const { service, assignments, prisma } = makeService();
    assignments.findById.mockResolvedValue(ASSIGNMENT);
    prisma.dailyStatus.findUnique.mockResolvedValue({
      solvedCount: 4,
      assignedCount: 4,
      isPerfect: true,
      completedAt: null,
      problemStatuses: [
        { problemId: 'p1', status: 'ACCEPTED', solvedAt: new Date() },
        { problemId: 'p2', status: 'ACCEPTED', solvedAt: new Date() },
        { problemId: 'p3', status: 'ACCEPTED', solvedAt: new Date() },
        { problemId: 'p4', status: 'ACCEPTED', solvedAt: new Date() },
      ],
    });

    const OTHER_STUDENT: RequestUser = {
      id: 'user-99',
      email: 'other@kalvium.community',
      name: 'Other Student',
      role: 'STUDENT',
      studentId: 'student-99',
    };

    await service.assignmentDetail(OTHER_STUDENT, 'a1');

    // The query was scoped to student-99, not student-1 — the two sessions can never
    // read each other's attempt data through the same assignment id.
    expect(prisma.dailyStatus.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentId_dayKey: { studentId: 'student-99', dayKey: '2026-08-10' } },
      }),
    );
  });
});
