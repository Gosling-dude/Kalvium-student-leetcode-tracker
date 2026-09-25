/**
 * Attempt counting for the Coding-Hours Attempts Analysis: the assignment period, the
 * failed-before-accepted rule and de-duplication, independent of any database.
 */

import { describe, expect, it } from 'vitest';

import {
  attemptWindow,
  compareAttemptRows,
  matchesAttemptView,
  summariseAttemptRows,
  summariseAttempts,
  type AttemptSubmission,
} from './attempts-analysis';

const DAY = '2026-09-20';
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

describe('attemptWindow', () => {
  it('starts on the assignment day, never before it, and ends where Coding Hours ends it', () => {
    expect(attemptWindow(DAY)).toEqual({ startDayKey: DAY, endDayKey: DAY });
  });
});

describe('summariseAttempts', () => {
  it('zero submissions is Not Attempted', () => {
    const r = summariseAttempts(DAY, []);
    expect(r).toMatchObject({ outcome: 'NOT_ATTEMPTED', attempts: 0, failedAttempts: 0, solved: false });
    expect(r.firstAttemptAt).toBeNull();
    expect(r.lastAttemptAt).toBeNull();
  });

  it('one failed submission is Attempted But Not Solved with 1 attempt', () => {
    expect(summariseAttempts(DAY, [failed('10:12')])).toMatchObject({
      outcome: 'ATTEMPTED_NOT_SOLVED',
      attempts: 1,
      failedAttempts: 1,
      solved: false,
    });
  });

  it('five failed submissions: 5 attempts, 5 failed', () => {
    const r = summariseAttempts(DAY, ['10:00', '10:05', '10:10', '10:15', '10:20'].map((t) => failed(t)));
    expect(r).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 5, failedAttempts: 5 });
  });

  it('three failed then accepted: 4 attempts, solved, 3 failed', () => {
    const r = summariseAttempts(DAY, [failed('09:10'), failed('09:20'), failed('09:30'), accepted('15:30')]);
    expect(r).toMatchObject({ outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 4, solved: true, failedAttempts: 3 });
    expect(r.firstAttemptAt).toEqual(new Date(`${DAY}T09:10:00+05:30`));
    expect(r.lastAttemptAt).toEqual(new Date(`${DAY}T15:30:00+05:30`));
  });

  it('submissions after the first accepted are attempts but not failed-before-solving', () => {
    const r = summariseAttempts(DAY, [failed('09:00'), accepted('09:30'), failed('10:00'), failed('10:30'), accepted('11:00')]);
    expect(r.attempts).toBe(5);
    expect(r.failedAttempts).toBe(1);
    expect(r.firstAcceptedAt).toEqual(new Date(`${DAY}T09:30:00+05:30`));
  });

  it('orders by time, not by input order', () => {
    const r = summariseAttempts(DAY, [accepted('15:00'), failed('09:00'), failed('10:00')]);
    expect(r.failedAttempts).toBe(2);
  });

  it('a submission before the assignment day is not an attempt at the assignment', () => {
    const r = summariseAttempts(DAY, [accepted('09:00', { dayKey: '2026-09-19' }), failed('10:00', { dayKey: '2026-09-18' })]);
    expect(r.outcome).toBe('NOT_ATTEMPTED');
    expect(r.attempts).toBe(0);
  });

  it('a submission after the assignment period is not counted either', () => {
    const r = summariseAttempts(DAY, [failed('10:00'), accepted('09:00', { dayKey: '2026-09-21' })]);
    expect(r).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1 });
  });

  it('the same mirrored submission twice is counted once', () => {
    const r = summariseAttempts(DAY, [
      failed('10:00', { id: '42' }),
      failed('10:00', { id: '42' }),
      failed('10:05', { id: '43' }),
      accepted('11:00', { id: '44' }),
      accepted('11:00', { id: '44' }),
    ]);
    expect(r.attempts).toBe(3);
    expect(r.failedAttempts).toBe(2);
    expect(r.submissions.map((s) => s.providerSubmissionId)).toEqual(['42', '43', '44']);
  });

  it('two submissions in the same second keep LeetCode id order', () => {
    const r = summariseAttempts(DAY, [accepted('10:00', { id: '101' }), failed('10:00', { id: '100' })]);
    expect(r.failedAttempts).toBe(1);
  });

  it('an unknown verdict is a submission but never a solve', () => {
    const r = summariseAttempts(DAY, [sub('UNKNOWN', '10:00')]);
    expect(r).toMatchObject({ outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1, solved: false });
  });
});

describe('views and order', () => {
  it('All Attempts is both attempted outcomes and never Not Attempted', () => {
    expect(matchesAttemptView('ATTEMPTED_NOT_SOLVED', 'ALL_ATTEMPTS')).toBe(true);
    expect(matchesAttemptView('SOLVED_AFTER_ATTEMPTS', 'ALL_ATTEMPTS')).toBe(true);
    expect(matchesAttemptView('NOT_ATTEMPTED', 'ALL_ATTEMPTS')).toBe(false);
    expect(matchesAttemptView('NOT_ATTEMPTED', 'NOT_ATTEMPTED')).toBe(true);
    expect(matchesAttemptView('SOLVED_AFTER_ATTEMPTS', 'ATTEMPTED_NOT_SOLVED')).toBe(false);
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

  it('summary counts students, not rows, for the student figures', () => {
    const summary = summariseAttemptRows([
      { studentId: 'a', outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 6, failedAttempts: 6 },
      { studentId: 'a', outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 3, failedAttempts: 3 },
      { studentId: 'b', outcome: 'ATTEMPTED_NOT_SOLVED', attempts: 1, failedAttempts: 1 },
      { studentId: 'c', outcome: 'SOLVED_AFTER_ATTEMPTS', attempts: 9, failedAttempts: 8 },
      { studentId: 'd', outcome: 'NOT_ATTEMPTED', attempts: 0, failedAttempts: 0 },
    ]);
    expect(summary).toEqual({
      studentsAttemptedNotSolved: 2,
      assignedProblemsAttempted: 4,
      totalFailedAttempts: 18,
      studentsWith3PlusNoAc: 1,
      studentsWith5PlusNoAc: 1,
    });
  });
});
