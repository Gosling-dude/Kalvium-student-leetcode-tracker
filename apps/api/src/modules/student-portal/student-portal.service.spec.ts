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
    findOne: vi.fn().mockResolvedValue({ id: 'student-1', batchId: 'batch-b' }),
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

describe('StudentPortalService.assignmentDetail — batch isolation', () => {
  it('returns the assignment when it targets the caller\'s own batch', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue({
      id: 'a1',
      dayKey: '2026-08-13',
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

  it('404s identically for an id that does not exist at all', async () => {
    const { service, assignments } = makeService();
    assignments.findById.mockResolvedValue(null);
    await expect(service.assignmentDetail(STUDENT_USER, 'missing')).rejects.toThrow(NotFoundException);
  });
});

describe('StudentPortalService.assignmentHistory — scoped to the caller\'s own batch', () => {
  it('passes the caller\'s batchId, never a client-supplied one', async () => {
    const { service, assignments } = makeService();
    await service.assignmentHistory(STUDENT_USER, { page: 1, pageSize: 20 } as never);
    expect(assignments.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'batch-b' }),
    );
  });
});
