/**
 * Provider profile refresh during sync.
 *
 * The defect these cover: `refreshProfile()` existed but had no callers, so
 * `StudentSyncState.providerTotalSolved` was NULL for every student. That column is the
 * only source for a student's true lifetime solved count — the submission mirror is
 * capped by LeetCode's 20-row window — so "Total Solved" silently degraded to the
 * mirror's undercount, showing values like 8 or 18 for students who had solved
 * thousands of problems.
 */

import { describe, expect, it, vi } from 'vitest';

import { StudentSyncService } from './student-sync.service';
import { ProviderProfilePrivateError, ProviderUserNotFoundError } from '../providers/provider.errors';

const PROFILE = {
  username: 'someone',
  displayName: 'Someone',
  realName: null,
  avatarUrl: null,
  ranking: 1234,
  totalSolved: 664,
  easySolved: 124,
  mediumSolved: 396,
  hardSolved: 144,
};

function makeHarness(options: {
  profileFetchedAt?: Date | null;
  submissionsThrow?: unknown;
  profileThrows?: boolean;
} = {}) {
  const state = {
    syncStateUpdates: [] as Record<string, unknown>[],
    studentUpdates: [] as Record<string, unknown>[],
  };

  const prisma = {
    student: {
      findUnique: vi.fn(async () => ({
        id: 'student-1',
        name: 'Someone',
        leetcodeUsername: 'someone',
        syncState: {
          lastSubmissionAt: null,
          providerProfileFetchedAt: options.profileFetchedAt ?? null,
        },
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.studentUpdates.push(data);
        return {};
      }),
    },
    problem: { findMany: vi.fn(async () => []) },
    submission: { createMany: vi.fn(async () => ({ count: 0 })) },
    studentSyncState: {
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
        state.syncStateUpdates.push(update);
        return {};
      }),
    },
    // The service uses $transaction([...]) with already-issued promises.
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const fetchUserProfile = vi.fn(async () => {
    if (options.profileThrows) throw new ProviderProfilePrivateError('someone');
    return PROFILE;
  });

  const provider = {
    name: 'leetcode',
    fetchRecentSubmissions: vi.fn(async () => {
      if (options.submissionsThrow) throw options.submissionsThrow;
      return { submissions: [], truncated: false, windowSize: 20 };
    }),
    fetchUserProfile,
  };

  const service = new StudentSyncService(
    prisma as never,
    { dayKeyOf: () => '2026-08-11' } as never,
    provider as never,
  );

  return { service, prisma, provider, fetchUserProfile, state };
}

describe('syncStudent — provider profile refresh', () => {
  it('fetches the profile when it has never been fetched', async () => {
    const h = makeHarness({ profileFetchedAt: null });
    await h.service.syncStudent('student-1');

    expect(h.fetchUserProfile).toHaveBeenCalledWith('someone');
    // The authoritative lifetime count is what actually gets persisted.
    const stats = h.state.syncStateUpdates.find((u) => 'providerTotalSolved' in u);
    expect(stats?.providerTotalSolved).toBe(664);
    expect(stats?.providerProfileFetchedAt).toBeInstanceOf(Date);
  });

  it('also refreshes the difficulty split, which was previously never populated', async () => {
    const h = makeHarness({ profileFetchedAt: null });
    await h.service.syncStudent('student-1');

    const update = h.state.studentUpdates.find((u) => 'easySolved' in u);
    expect(update).toMatchObject({ easySolved: 124, mediumSolved: 396, hardSolved: 144 });
  });

  it('skips the profile when it was fetched recently', async () => {
    // Sync runs every 3 hours; a profile from an hour ago is still fresh.
    const h = makeHarness({ profileFetchedAt: new Date(Date.now() - 60 * 60 * 1000) });
    await h.service.syncStudent('student-1');
    expect(h.fetchUserProfile).not.toHaveBeenCalled();
  });

  it('refreshes again once the profile is older than the TTL', async () => {
    const h = makeHarness({ profileFetchedAt: new Date(Date.now() - 13 * 60 * 60 * 1000) });
    await h.service.syncStudent('student-1');
    expect(h.fetchUserProfile).toHaveBeenCalledTimes(1);
  });

  it('still fetches the profile when the submission list is private', async () => {
    // LeetCode hides a private account's submissions while still serving its aggregate
    // stats, so such a student must not be stranded showing 0 solved.
    const h = makeHarness({
      profileFetchedAt: null,
      submissionsThrow: new ProviderProfilePrivateError('someone'),
    });

    const result = await h.service.syncStudent('student-1');

    expect(result.status).toBe('PROFILE_PRIVATE');
    expect(h.fetchUserProfile).toHaveBeenCalledTimes(1);
    const stats = h.state.syncStateUpdates.find((u) => 'providerTotalSolved' in u);
    expect(stats?.providerTotalSolved).toBe(664);
  });

  it('does not waste a profile call when the account does not exist', async () => {
    const h = makeHarness({
      profileFetchedAt: null,
      submissionsThrow: new ProviderUserNotFoundError('someone'),
    });

    const result = await h.service.syncStudent('student-1');

    expect(result.status).toBe('USER_NOT_FOUND');
    expect(h.fetchUserProfile).not.toHaveBeenCalled();
  });

  it('does not fail the submission sync when the profile call fails', async () => {
    // Submissions cannot be re-fetched later; profile stats can. Never trade one for
    // the other.
    const h = makeHarness({ profileFetchedAt: null, profileThrows: true });
    const result = await h.service.syncStudent('student-1');
    expect(result.status).toBe('OK');
    expect(result.error).toBeNull();
  });
});
