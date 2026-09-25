/**
 * Attempt counting for the Coding-Hours Attempts Analysis: the assignment period, the
 * failed-before-accepted rule, de-duplication and the no-evidence states, independent of
 * any database.
 */

import { describe, expect, it } from 'vitest';

import {
  attemptWindows,
  compareAttemptRows,
  matchesAttemptView,
  summariseAttemptRows,
  summariseAttempts,
  summariseStudentAttempts,
  type AttemptSubmission,
  type AttemptWindow,
} from './attempts-analysis';

const DAY = '2026-09-20';
const OPEN: AttemptWindow = { startDayKey: DAY, endDayKey: null };
let nextId = 1_000_000;

const sub = (status: string, time: string, options: { dayKey?: string; id?: string } = {}): AttemptSubmission => ({
  providerSubmissionId: options.id ?? String(nextId++),
  status,
  submittedAt: new Date(`${options.dayKey ?? DAY}T${time}:00+05:30`),
  dayKey: options.dayKey ?? DAY,
  language: 'python3',
});

const failed = (time: string, options?: { dayKey?: string; id?: string }) => sub('ATTEMPTED_NOT_ACCEPTED', time, options);
const accepted = (time: string, options?: { dayKey?: string; id?: string }) => sub('ACCEPTED', time, options);

describe('attemptWindows', () => {
  it('runs from each assignment day to the day before the same problem is assigned again', () => {
    const w = attemptWindows(['2026-09-20', '2026-08-31', '2026-09-01']);
    expect(w.get('2026-08-31')).toEqual({ startDayKey: '2026-08-31', endDayKey: '2026-08-31' });
    expect(w.get('2026-09-01')).toEqual({ startDayKey: '2026-09-01', endDayKey: '2026-09-19' });
    expect(w.get('2026-09-20')).toEqual({ startDayKey: '2026-09-20', endDayKey: null });
  });
});

describe('summariseAttempts', () => {
  it('A. zero submissions and never solved: Not Attempted', () => {
    const r = summariseAttempts(OPEN, []);
    expect(r).toMatchObject({ outcome: 'NOT_ATTEMPTED', attempts: 0, failedAttempts: 0, solved: false });
    expect([r.firstAttemptAt, r.firstAcceptedAt, r.lastAttemptAt]).toEqual([null, null, null]);
  });

  it('B. one failed: Attempted But Not Solved, 1 attempt, 1 failed', () => {
    expect(summariseAttempts(OPEN, [failed('10:12')])).toMatchObject({
      outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1, failedAttempts: 1, solved: false, firstAcceptedAt: null,
    });
  });

  it('C. three failed: 3 attempts, 3 failed', () => {
    const r = summariseAttempts(OPEN, [failed('10:00'), failed('10:05'), failed('10:10')]);
    expect(r).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 3, failedAttempts: 3 });
  });

  it('D. one failed then accepted: Solved After Attempts, 2 attempts, 1 failed', () => {
    const r = summariseAttempts(OPEN, [failed('10:05'), accepted('10:32')]);
    expect(r).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 2, failedAttempts: 1, solved: true });
    expect(r.firstAcceptedAt).toEqual(new Date(`${DAY}T10:32:00+05:30`));
  });

  it('E. two failed then accepted: 3 attempts, 2 failed', () => {
    const r = summariseAttempts(OPEN, [failed('10:05'), failed('10:20'), accepted('10:32')]);
    expect(r).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 3, failedAttempts: 2 });
  });

  it('F. failed, accepted, accepted: 3 attempts, 1 failed; later accepted is not a failure', () => {
    const r = summariseAttempts(OPEN, [failed('10:05'), accepted('10:32'), accepted('10:40')]);
    expect(r).toMatchObject({ attempts: 3, failedAttempts: 1, acceptedCount: 2 });
    expect(r.lastAttemptAt).toEqual(new Date(`${DAY}T10:40:00+05:30`));
  });

  it('failures after the first accepted are not failed-before-solving', () => {
    const r = summariseAttempts(OPEN, [failed('09:00'), accepted('09:30'), failed('10:00'), failed('10:30')]);
    expect(r).toMatchObject({ attempts: 4, failedAttempts: 1 });
  });

  it('accepted on the first try is its own outcome, not Solved After Attempts', () => {
    expect(summariseAttempts(OPEN, [accepted('09:00')])).toMatchObject({ outcome: 'SOLVED_FIRST_ATTEMPT', failedAttempts: 0 });
  });

  it('G. the same submission id twice counts once', () => {
    const r = summariseAttempts(OPEN, [
      failed('10:00', { id: '42' }),
      failed('10:00', { id: '42' }),
      accepted('11:00', { id: '44' }),
      accepted('11:00', { id: '44' }),
    ]);
    expect(r).toMatchObject({ attempts: 2, failedAttempts: 1 });
    expect(r.submissions.map((s) => s.providerSubmissionId)).toEqual(['42', '44']);
  });

  it('H. submissions outside the period are not counted', () => {
    const w: AttemptWindow = { startDayKey: DAY, endDayKey: '2026-09-22' };
    const r = summariseAttempts(w, [
      failed('10:00', { dayKey: '2026-09-19' }),
      failed('10:00', { dayKey: '2026-09-22' }),
      accepted('10:00', { dayKey: '2026-09-23' }),
    ]);
    expect(r).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1 });
  });

  it('a later day inside the period counts', () => {
    const r = summariseAttempts(OPEN, [failed('10:00'), accepted('09:00', { dayKey: '2026-09-21' })]);
    expect(r).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 2, failedAttempts: 1 });
  });

  it('solved before the assignment and untouched since is not Not Attempted', () => {
    const r = summariseAttempts(OPEN, [accepted('09:00', { dayKey: '2026-06-01' })]);
    expect(r).toMatchObject({ outcome: 'SOLVED_BEFORE_ASSIGNMENT', attempts: 0, failedAttempts: 0 });
  });

  it('J. unreadable profile with no evidence is No Data, never a zero-attempt student', () => {
    expect(summariseAttempts(OPEN, [], { dataReadable: false }).outcome).toBe('NO_DATA');
    // Evidence that does exist is still used.
    expect(summariseAttempts(OPEN, [failed('10:00')], { dataReadable: false }).outcome).toBe('ATTEMPTED_NOT_SOLVED');
  });

  it('orders by time, then by LeetCode id within the same second', () => {
    expect(summariseAttempts(OPEN, [accepted('15:00'), failed('09:00')]).failedAttempts).toBe(1);
    expect(summariseAttempts(OPEN, [accepted('10:00', { id: '101' }), failed('10:00', { id: '100' })]).failedAttempts).toBe(1);
  });

  it('an unknown verdict is a submission but never a solve', () => {
    expect(summariseAttempts(OPEN, [sub('UNKNOWN', '10:00')])).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1 });
  });
});

describe('views, order and summaries', () => {
  it('ALL matches every outcome; others match only themselves', () => {
    expect(matchesAttemptView('NO_DATA', 'ALL')).toBe(true);
    expect(matchesAttemptView('SOLVED_FIRST_ATTEMPT', 'SOLVED_AFTER_ATTEMPTS')).toBe(false);
    expect(matchesAttemptView('SOLVED_AFTER_ATTEMPTS', 'SOLVED_AFTER_ATTEMPTS')).toBe(true);
  });

  it('sorts failed desc, attempts desc, name asc', () => {
    const base = { dayKey: DAY, position: 1 };
    const rows = [
      { ...base, name: 'Zed', failedAttempts: 3, attempts: 3 },
      { ...base, name: 'Amy', failedAttempts: 3, attempts: 4 },
      { ...base, name: 'Bob', failedAttempts: 6, attempts: 6 },
      { ...base, name: 'Abe', failedAttempts: 3, attempts: 3 },
    ].sort(compareAttemptRows);
    expect(rows.map((r) => r.name)).toEqual(['Bob', 'Amy', 'Abe', 'Zed']);
  });

  it('management summary', () => {
    expect(
      summariseAttemptRows([
        { studentId: 'a', outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 6, failedAttempts: 6 },
        { studentId: 'a', outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 3, failedAttempts: 3 },
        { studentId: 'b', outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1, failedAttempts: 1 },
        { studentId: 'c', outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 2, failedAttempts: 1 },
        { studentId: 'c', outcome: 'SOLVED_FIRST_ATTEMPT', attempts: 1, failedAttempts: 0 },
        { studentId: 'd', outcome: 'NOT_ATTEMPTED', attempts: 0, failedAttempts: 0 },
      ]),
    ).toEqual({
      attemptedNotSolved: 3,
      studentsAttemptedNotSolved: 2,
      assignedProblemsAttempted: 5,
      totalFailedAttempts: 11,
      solvedAfterMultipleAttempts: 1,
      problemsWith2PlusAttempts: 3,
      problemsWith3PlusAttempts: 2,
      problemsWith5PlusAttempts: 1,
    });
  });

  it('student stats', () => {
    expect(
      summariseStudentAttempts([
        { outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 2, failedAttempts: 2, solved: false },
        { outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 3, failedAttempts: 2, solved: true },
        { outcome: 'SOLVED_FIRST_ATTEMPT', attempts: 1, failedAttempts: 0, solved: true },
        { outcome: 'NOT_ATTEMPTED', attempts: 0, failedAttempts: 0, solved: false },
      ]),
    ).toEqual({
      assignedProblems: 4,
      attempted: 3,
      solved: 2,
      attemptedNotSolved: 1,
      solvedAfterAttempts: 1,
      totalAttempts: 6,
      totalFailedAttempts: 4,
      averageAttemptsPerSolvedProblem: 2,
    });
  });
});
