/**
 * "Could not read this student" has to mean a read was attempted.
 *
 * Production ran eight syncs a day, every one of them finishing `COMPLETED_WITH_ERRORS`
 * with 22 failures, and the dashboard reporting "22 students' data could not be read this
 * sync". 21 of those 22 students had no LeetCode handle at all: the sync never called the
 * provider for them, so nothing about them had failed. A roster gap was being reported as
 * a system fault, on a permanent basis, across an entire campus.
 *
 * These cover the classification that separates the two, at the three points that decide
 * what the operator is told: the per-student outcome, the predicate the job counts with,
 * and the summary written into the job row.
 */

import { describe, expect, it, vi } from 'vitest';
import { isSyncFailure, isTrustworthySync, wasSyncAttempted, type SyncStatus } from '@dsa/shared';

import { StudentSyncService } from './student-sync.service';

describe('sync status classification', () => {
  it('treats a missing profile as unattempted, not as a failure', () => {
    expect(wasSyncAttempted('PROFILE_MISSING')).toBe(false);
    expect(isSyncFailure('PROFILE_MISSING')).toBe(false);
  });

  it('treats a pending first sync as unattempted too — it fixes itself next run', () => {
    expect(wasSyncAttempted('NEVER_SYNCED')).toBe(false);
    expect(isSyncFailure('NEVER_SYNCED')).toBe(false);
  });

  it('counts every genuine provider outcome as a failure', () => {
    const failures: SyncStatus[] = [
      'USER_NOT_FOUND',
      'PROFILE_PRIVATE',
      'RATE_LIMITED',
      'PROVIDER_ERROR',
      'TIMEOUT',
    ];
    for (const status of failures) {
      expect(isSyncFailure(status), status).toBe(true);
    }
  });

  it('does not count a success as a failure', () => {
    expect(isSyncFailure('OK')).toBe(false);
    expect(wasSyncAttempted('OK')).toBe(true);
  });

  it('keeps "trustworthy" and "did not fail" as separate questions', () => {
    // A student with no handle has an unreliable zero *and* no failure. Deriving one from
    // the other is precisely what produced the misleading banner.
    expect(isTrustworthySync('PROFILE_MISSING')).toBe(false);
    expect(isSyncFailure('PROFILE_MISSING')).toBe(false);
  });

  it('classifies every status as exactly one of ok / unattempted / failed', () => {
    const all: SyncStatus[] = [
      'OK',
      'PROFILE_MISSING',
      'NEVER_SYNCED',
      'USER_NOT_FOUND',
      'PROFILE_PRIVATE',
      'RATE_LIMITED',
      'PROVIDER_ERROR',
      'TIMEOUT',
    ];
    for (const status of all) {
      const buckets = [
        status === 'OK',
        !wasSyncAttempted(status),
        isSyncFailure(status),
      ].filter(Boolean);
      expect(buckets, `${status} landed in ${buckets.length} buckets`).toHaveLength(1);
    }
  });
});

describe('syncStudent — a student with no linked handle', () => {
  function harness(leetcodeUsername: string | null) {
    const syncStateUpdates: Record<string, unknown>[] = [];
    const fetchRecentSubmissions = vi.fn(async () => ({
      submissions: [],
      truncated: false,
      windowSize: 20,
    }));

    const prisma = {
      student: {
        findUnique: vi.fn(async () => ({
          id: 'student-1',
          name: 'Someone',
          leetcodeUsername,
          syncState: { lastSubmissionAt: null, providerProfileFetchedAt: new Date() },
        })),
        update: vi.fn(async () => ({})),
      },
      problem: { findMany: vi.fn(async () => []) },
      submission: { createMany: vi.fn(async () => ({ count: 0 })) },
      studentSyncState: {
        upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
          syncStateUpdates.push(update);
          return {};
        }),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const provider = {
      name: 'leetcode',
      fetchRecentSubmissions,
      fetchUserProfile: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    const service = new StudentSyncService(
      prisma as never,
      { dayKeyOf: () => '2026-08-23' } as never,
      provider as never,
    );

    return { service, fetchRecentSubmissions, syncStateUpdates };
  }

  it('is reported as PROFILE_MISSING rather than NEVER_SYNCED', async () => {
    const h = harness(null);
    const result = await h.service.syncStudent('student-1');

    expect(result.status).toBe('PROFILE_MISSING');
    expect(isSyncFailure(result.status)).toBe(false);
  });

  it('never calls the provider, so there is no read that could have failed', async () => {
    const h = harness(null);
    await h.service.syncStudent('student-1');
    expect(h.fetchRecentSubmissions).not.toHaveBeenCalled();
  });

  it('records why, so the directory can say what the admin needs to do', async () => {
    const h = harness(null);
    await h.service.syncStudent('student-1');

    const update = h.syncStateUpdates.find((entry) => 'status' in entry);
    expect(update?.status).toBe('PROFILE_MISSING');
    expect(update?.lastError).toContain('No LeetCode username');
  });

  it('still syncs normally once a handle is linked', async () => {
    const h = harness('someone');
    const result = await h.service.syncStudent('student-1');

    expect(h.fetchRecentSubmissions).toHaveBeenCalledWith('someone', expect.anything());
    expect(result.status).toBe('OK');
  });
});
