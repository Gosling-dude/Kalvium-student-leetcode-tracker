/**
 * In-memory `SubmissionProvider` for tests and offline development.
 *
 * This exists to prove the abstraction is real: the sync engine, scoring, streaks and
 * every report can be exercised end-to-end with no network at all. It also lets tests
 * reproduce the failure modes that are hard to trigger against the live API on demand —
 * rate limiting, private profiles, timeouts, and the truncated-window case that is the
 * single most consequential property of the real provider.
 */

import { Injectable } from '@nestjs/common';
import type { Difficulty, ProblemStatus } from '@dsa/shared';
import { leetcodeProblemUrl } from '@dsa/shared';

import {
  ProviderProblemNotFoundError,
  ProviderProfilePrivateError,
  ProviderRateLimitedError,
  ProviderTimeoutError,
  ProviderUserNotFoundError,
} from '../provider.errors';
import type {
  FetchSubmissionsOptions,
  ProviderProblemMetadata,
  ProviderSubmission,
  ProviderSubmissionPage,
  ProviderUserProfile,
  SubmissionProvider,
} from '../provider.types';

export interface FakeSubmissionSeed {
  titleSlug: string;
  title?: string;
  submittedAt: Date;
  status?: ProblemStatus;
  language?: string;
}

export interface FakeUserSeed {
  submissions: FakeSubmissionSeed[];
  profile?: Partial<ProviderUserProfile>;
  /** Simulated failure mode for this user, applied on every call. */
  failure?: 'NOT_FOUND' | 'PRIVATE' | 'RATE_LIMITED' | 'TIMEOUT';
}

@Injectable()
export class FakeSubmissionProvider implements SubmissionProvider {
  readonly name = 'fake';

  private readonly users = new Map<string, FakeUserSeed>();
  private readonly problems = new Map<string, ProviderProblemMetadata>();

  /** Mirrors the real provider's hard cap so tests exercise truncation faithfully. */
  windowSize = 20;

  /** Call counter, so tests can assert the sync is not making redundant requests. */
  callCount = 0;

  // -------------------------------------------------------------------------
  // Test seeding
  // -------------------------------------------------------------------------

  setUser(username: string, seed: FakeUserSeed): void {
    this.users.set(username.toLowerCase(), seed);
  }

  setProblem(metadata: Partial<ProviderProblemMetadata> & { titleSlug: string }): void {
    this.problems.set(metadata.titleSlug.toLowerCase(), {
      title: this.titleFromSlug(metadata.titleSlug),
      questionId: null,
      questionFrontendId: null,
      difficulty: 'MEDIUM' as Difficulty,
      acceptanceRate: 50,
      isPaidOnly: false,
      topicTags: [],
      companyTags: [],
      url: leetcodeProblemUrl(metadata.titleSlug),
      ...metadata,
    });
  }

  reset(): void {
    this.users.clear();
    this.problems.clear();
    this.callCount = 0;
  }

  // -------------------------------------------------------------------------
  // Contract
  // -------------------------------------------------------------------------

  async fetchRecentSubmissions(
    username: string,
    options: FetchSubmissionsOptions = {},
  ): Promise<ProviderSubmissionPage> {
    this.callCount += 1;
    const seed = this.requireUser(username);

    const includeNonAccepted = options.includeNonAccepted ?? true;
    const limit = Math.min(options.limit ?? this.windowSize, this.windowSize);

    const all = [...seed.submissions].sort(
      (a, b) => b.submittedAt.getTime() - a.submittedAt.getTime(),
    );

    const visible = includeNonAccepted
      ? all
      : all.filter((s) => (s.status ?? 'ACCEPTED') === 'ACCEPTED');

    // Truncate *before* filtering by `since`, exactly as the real provider does — the
    // upstream window is applied by LeetCode, not by us.
    const windowed = visible.slice(0, limit);

    const submissions = windowed.map((seedItem, index) =>
      this.toSubmission(username, seedItem, index),
    );

    const since = options.since ?? null;
    const filtered = since
      ? submissions.filter((submission) => submission.submittedAt > since)
      : submissions;

    return {
      submissions: filtered,
      truncated: visible.length >= limit,
      windowSize: this.windowSize,
      fetchedAt: new Date(),
    };
  }

  async fetchSolvedProblems(
    username: string,
    options: FetchSubmissionsOptions = {},
  ): Promise<ProviderSubmissionPage> {
    const page = await this.fetchRecentSubmissions(username, {
      ...options,
      includeNonAccepted: false,
    });
    return {
      ...page,
      submissions: page.submissions.filter((s) => s.status === 'ACCEPTED'),
    };
  }

  async fetchSubmission(
    username: string,
    problemSlug: string,
  ): Promise<ProviderSubmission | null> {
    const page = await this.fetchRecentSubmissions(username, { includeNonAccepted: true });
    const slug = problemSlug.toLowerCase();
    return page.submissions.find((s) => s.titleSlug.toLowerCase() === slug) ?? null;
  }

  async fetchUserProfile(username: string): Promise<ProviderUserProfile> {
    this.callCount += 1;
    const seed = this.requireUser(username);

    const accepted = seed.submissions.filter((s) => (s.status ?? 'ACCEPTED') === 'ACCEPTED');
    const uniqueSlugs = new Set(accepted.map((s) => s.titleSlug));

    return {
      username,
      displayName: username,
      realName: null,
      avatarUrl: null,
      ranking: null,
      totalSolved: uniqueSlugs.size,
      easySolved: 0,
      mediumSolved: uniqueSlugs.size,
      hardSolved: 0,
      ...seed.profile,
    };
  }

  async fetchProblemMetadata(problemSlug: string): Promise<ProviderProblemMetadata> {
    this.callCount += 1;
    const slug = problemSlug.toLowerCase();
    const known = this.problems.get(slug);
    if (known) return known;

    // Unknown-but-plausible slugs resolve to a synthetic problem so tests need not
    // seed every problem they touch. Genuinely invalid slugs still fail.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new ProviderProblemNotFoundError(slug);
    }

    return {
      titleSlug: slug,
      title: this.titleFromSlug(slug),
      questionId: null,
      questionFrontendId: null,
      difficulty: 'MEDIUM',
      acceptanceRate: 50,
      isPaidOnly: false,
      topicTags: ['Array'],
      companyTags: [],
      url: leetcodeProblemUrl(slug),
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireUser(username: string): FakeUserSeed {
    const seed = this.users.get(username.toLowerCase());
    if (!seed) throw new ProviderUserNotFoundError(username);

    switch (seed.failure) {
      case 'NOT_FOUND':
        throw new ProviderUserNotFoundError(username);
      case 'PRIVATE':
        throw new ProviderProfilePrivateError(username);
      case 'RATE_LIMITED':
        throw new ProviderRateLimitedError('Simulated rate limit', username);
      case 'TIMEOUT':
        throw new ProviderTimeoutError(username);
      default:
        return seed;
    }
  }

  private toSubmission(
    username: string,
    seed: FakeSubmissionSeed,
    index: number,
  ): ProviderSubmission {
    return {
      // Deterministic id so re-running a sync in a test is genuinely idempotent.
      id: `fake-${username}-${seed.titleSlug}-${seed.submittedAt.getTime()}-${index}`,
      titleSlug: seed.titleSlug,
      title: seed.title ?? this.titleFromSlug(seed.titleSlug),
      status: seed.status ?? 'ACCEPTED',
      submittedAt: seed.submittedAt,
      language: seed.language ?? 'python3',
      runtime: null,
      memory: null,
    };
  }

  private titleFromSlug(slug: string): string {
    return slug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
