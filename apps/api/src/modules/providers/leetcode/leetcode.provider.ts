/**
 * LeetCode implementation of `SubmissionProvider`.
 *
 * This file is the *only* place in the codebase that knows LeetCode exists. Everything
 * upstream-specific — GraphQL documents, the 20-row window, the string-encoded epoch
 * timestamps, the "That user does not exist." error string — is contained here and
 * translated into the neutral domain types before it escapes.
 *
 * LeetCode publishes no official API for submission history. This uses the same public
 * GraphQL endpoint the website itself calls, at a deliberately conservative request
 * rate. If it ever stops working, replacing this one class is the entire migration.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  LEETCODE_RECENT_AC_LIMIT,
  LEETCODE_RECENT_SUBMISSION_LIMIT,
  fromEpochSeconds,
  leetcodeProblemUrl,
  type Difficulty,
  type ProblemStatus,
} from '@dsa/shared';

import { CONFIG_TOKEN, type AppConfig } from '../../../config/configuration';
import {
  ProviderProblemNotFoundError,
  ProviderProfilePrivateError,
  ProviderRateLimitedError,
  ProviderRequestError,
  ProviderTimeoutError,
  ProviderUserNotFoundError,
  isRetryable,
} from '../provider.errors';
import { RateLimiter, retryWithBackoff } from '../rate-limiter';
import type {
  FetchSubmissionsOptions,
  ProviderProblemMetadata,
  ProviderSubmission,
  ProviderSubmissionPage,
  ProviderUserProfile,
  SubmissionProvider,
} from '../provider.types';
import {
  HEALTHCHECK_QUERY,
  PROBLEM_METADATA_QUERY,
  RECENT_AC_SUBMISSIONS_QUERY,
  RECENT_SUBMISSIONS_QUERY,
  USER_PROFILE_QUERY,
  type GraphQLResponse,
  type RawAcSubmission,
  type RawMatchedUser,
  type RawQuestion,
  type RawSubmission,
} from './leetcode.queries';

/** Upstream error text that identifies a non-existent user. Verified against the live API. */
const USER_NOT_FOUND_MARKERS = ['that user does not exist', 'user does not exist'];

@Injectable()
export class LeetCodeProvider implements SubmissionProvider {
  readonly name = 'leetcode';

  private readonly logger = new Logger(LeetCodeProvider.name);
  private readonly limiter: RateLimiter;

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {
    this.limiter = new RateLimiter({
      requestsPerSecond: config.provider.requestsPerSecond,
      concurrency: config.provider.concurrency,
    });
  }

  // -------------------------------------------------------------------------
  // Public contract
  // -------------------------------------------------------------------------

  async fetchRecentSubmissions(
    username: string,
    options: FetchSubmissionsOptions = {},
  ): Promise<ProviderSubmissionPage> {
    const includeNonAccepted = options.includeNonAccepted ?? true;

    // The richer query also reports failed attempts, which lets the mentor dashboard
    // distinguish "tried and failed" from "never opened the problem".
    const windowSize = includeNonAccepted
      ? LEETCODE_RECENT_SUBMISSION_LIMIT
      : LEETCODE_RECENT_AC_LIMIT;
    const limit = Math.min(options.limit ?? windowSize, windowSize);

    const raw = includeNonAccepted
      ? await this.request<{ recentSubmissionList: RawSubmission[] | null }>(
          RECENT_SUBMISSIONS_QUERY,
          { username, limit },
          username,
        )
      : await this.request<{ recentAcSubmissionList: RawAcSubmission[] | null }>(
          RECENT_AC_SUBMISSIONS_QUERY,
          { username, limit },
          username,
        );

    const rows: (RawSubmission | RawAcSubmission)[] =
      ('recentSubmissionList' in raw ? raw.recentSubmissionList : raw.recentAcSubmissionList) ??
      [];

    // An empty list from a user we cannot otherwise verify is ambiguous: it may mean
    // "no submissions" or "profile hidden". We resolve it by checking the profile,
    // because reporting a hidden profile as "solved 0" misleads mentors.
    if (rows.length === 0) {
      await this.assertUserExists(username);
    }

    const submissions = rows
      .map((row) => this.toProviderSubmission(row))
      .filter((submission): submission is ProviderSubmission => submission !== null)
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());

    const since = options.since ?? null;
    const filtered = since
      ? submissions.filter((submission) => submission.submittedAt > since)
      : submissions;

    return {
      submissions: filtered,
      // Truncation is only meaningful when the provider filled the window: a full
      // window means older submissions certainly exist beyond our reach.
      truncated: rows.length >= windowSize,
      windowSize,
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
      submissions: page.submissions.filter((submission) => submission.status === 'ACCEPTED'),
    };
  }

  async fetchSubmission(
    username: string,
    problemSlug: string,
  ): Promise<ProviderSubmission | null> {
    // There is no per-problem submission query on the public endpoint, so this is a
    // scan of the reachable window. It therefore cannot see older submissions — which
    // is precisely why the sync engine maintains a local mirror instead of relying on
    // this call for historical questions.
    const page = await this.fetchRecentSubmissions(username, { includeNonAccepted: true });
    const slug = problemSlug.toLowerCase();
    return (
      page.submissions.find((submission) => submission.titleSlug.toLowerCase() === slug) ?? null
    );
  }

  async fetchUserProfile(username: string): Promise<ProviderUserProfile> {
    const data = await this.request<{ matchedUser: RawMatchedUser | null }>(
      USER_PROFILE_QUERY,
      { username },
      username,
    );

    const user = data.matchedUser;
    if (!user) throw new ProviderUserNotFoundError(username);

    const stats = user.submitStats?.acSubmissionNum ?? [];
    const statFor = (difficulty: string): number =>
      stats.find((entry) => entry.difficulty === difficulty)?.count ?? 0;

    return {
      username: user.username,
      displayName: user.username,
      realName: user.profile?.realName ?? null,
      avatarUrl: user.profile?.userAvatar ?? null,
      ranking: user.profile?.ranking ?? null,
      totalSolved: statFor('All'),
      easySolved: statFor('Easy'),
      mediumSolved: statFor('Medium'),
      hardSolved: statFor('Hard'),
    };
  }

  async fetchProblemMetadata(problemSlug: string): Promise<ProviderProblemMetadata> {
    const slug = problemSlug.toLowerCase();
    const data = await this.request<{ question: RawQuestion | null }>(
      PROBLEM_METADATA_QUERY,
      { titleSlug: slug },
      undefined,
    );

    const question = data.question;
    if (!question) throw new ProviderProblemNotFoundError(slug);

    return {
      titleSlug: question.titleSlug,
      title: question.title,
      questionId: question.questionId,
      questionFrontendId: question.questionFrontendId,
      difficulty: this.toDifficulty(question.difficulty),
      // `acRate` arrives as a percentage already (e.g. 57.93), not a 0–1 ratio.
      acceptanceRate:
        typeof question.acRate === 'number' ? Math.round(question.acRate * 100) / 100 : null,
      isPaidOnly: question.isPaidOnly ?? false,
      topicTags: (question.topicTags ?? []).map((tag) => tag.name),
      // Verified premium-gated: the public endpoint returns null for companyTags.
      companyTags: [],
      url: leetcodeProblemUrl(question.titleSlug),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request<{ allQuestionsCount: unknown }>(HEALTHCHECK_QUERY, {}, undefined, 1);
      return true;
    } catch (error) {
      this.logger.warn(`LeetCode health check failed: ${(error as Error).message}`);
      return false;
    }
  }

  onModuleDestroy(): void {
    this.limiter.destroy();
  }

  /** Exposed for the queue-health endpoint. */
  limiterStats(): { queued: number; active: number; availableTokens: number } {
    return this.limiter.stats();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Confirm a user exists. Used to disambiguate an empty submission list, which the
   * API returns identically for "no submissions" and "not visible to you".
   */
  private async assertUserExists(username: string): Promise<void> {
    const data = await this.request<{ matchedUser: RawMatchedUser | null }>(
      USER_PROFILE_QUERY,
      { username },
      username,
    );
    if (!data.matchedUser) throw new ProviderUserNotFoundError(username);

    // The account exists and claims solved problems, yet the feed came back empty —
    // the submission history is hidden. Recording this as "solved 0" would be wrong.
    const solved =
      data.matchedUser.submitStats?.acSubmissionNum?.find((e) => e.difficulty === 'All')?.count ??
      0;
    if (solved > 0) throw new ProviderProfilePrivateError(username);
  }

  private toProviderSubmission(
    row: RawSubmission | RawAcSubmission,
  ): ProviderSubmission | null {
    try {
      const hasStatus = 'statusDisplay' in row;
      return {
        id: String(row.id),
        titleSlug: row.titleSlug,
        title: row.title,
        // The AC-only query returns exclusively accepted rows, so anything from it is ACCEPTED.
        status: hasStatus ? this.toProblemStatus(row.statusDisplay) : 'ACCEPTED',
        submittedAt: fromEpochSeconds(row.timestamp),
        language: hasStatus ? (row.lang ?? null) : null,
        // Not exposed by either public query. Nullable by design, never faked.
        runtime: null,
        memory: null,
      };
    } catch (error) {
      // One malformed row must not fail an entire student's sync.
      this.logger.warn(
        `Skipping unparseable submission ${String((row as RawAcSubmission).id)}: ${
          (error as Error).message
        }`,
      );
      return null;
    }
  }

  private toProblemStatus(statusDisplay: string | null | undefined): ProblemStatus {
    if (!statusDisplay) return 'UNKNOWN';
    // Only "Accepted" earns points — every other verdict is an attempt.
    return statusDisplay.trim().toLowerCase() === 'accepted'
      ? 'ACCEPTED'
      : 'ATTEMPTED_NOT_ACCEPTED';
  }

  private toDifficulty(raw: string): Difficulty {
    switch (raw?.toLowerCase()) {
      case 'easy':
        return 'EASY';
      case 'hard':
        return 'HARD';
      case 'medium':
      default:
        return 'MEDIUM';
    }
  }

  /** Rate-limited, retried, timed-out GraphQL request with upstream error translation. */
  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    username?: string,
    maxRetries = this.config.provider.maxRetries,
  ): Promise<T> {
    return retryWithBackoff<T>(
      async () => this.limiter.schedule(() => this.execute<T>(query, variables, username)),
      {
        maxRetries,
        initialBackoffMs: 1_000,
        maxBackoffMs: 30_000,
        isRetryable,
        onRetry: (attempt, delayMs, error) => {
          this.logger.warn(
            `Provider retry ${attempt}/${maxRetries} in ${delayMs}ms` +
              `${username ? ` for "${username}"` : ''}: ${(error as Error).message}`,
          );
        },
      },
    );
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown>,
    username?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.provider.timeoutMs);

    try {
      const response = await fetch(this.config.provider.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        throw new ProviderRateLimitedError(
          'LeetCode returned HTTP 429',
          username,
          Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined,
        );
      }

      // 403 from this endpoint indicates bot detection rather than a per-user
      // permission problem, so it is treated as throttling and backed off.
      if (response.status === 403) {
        throw new ProviderRateLimitedError('LeetCode returned HTTP 403', username);
      }

      if (!response.ok) {
        throw new ProviderRequestError(
          `LeetCode returned HTTP ${response.status}`,
          username,
          undefined,
          // 4xx other than the above will not fix themselves; 5xx might.
          response.status >= 500,
        );
      }

      const payload = (await response.json()) as GraphQLResponse<T>;

      if (payload.errors?.length) {
        const message = payload.errors.map((e) => e.message).join('; ');
        if (
          username &&
          USER_NOT_FOUND_MARKERS.some((marker) => message.toLowerCase().includes(marker))
        ) {
          throw new ProviderUserNotFoundError(username);
        }
        throw new ProviderRequestError(`LeetCode GraphQL error: ${message}`, username, undefined, false);
      }

      if (payload.data === null || payload.data === undefined) {
        throw new ProviderRequestError('LeetCode returned an empty payload', username);
      }

      return payload.data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderTimeoutError(username, error);
      }
      // Preserve our own typed errors; wrap only genuinely unknown transport failures.
      if (
        error instanceof ProviderRateLimitedError ||
        error instanceof ProviderRequestError ||
        error instanceof ProviderUserNotFoundError ||
        error instanceof ProviderProfilePrivateError ||
        error instanceof ProviderTimeoutError ||
        error instanceof ProviderProblemNotFoundError
      ) {
        throw error;
      }
      throw new ProviderRequestError(
        `LeetCode request failed: ${(error as Error).message}`,
        username,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // The endpoint rejects requests without a browser-like User-Agent and Referer.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://leetcode.com',
      Origin: 'https://leetcode.com',
    };

    // Optional authenticated mode. Not required — everything the programme needs works
    // anonymously — but a session unlocks richer detail for deployments that have one.
    if (this.config.provider.sessionCookie) {
      const parts = [`LEETCODE_SESSION=${this.config.provider.sessionCookie}`];
      if (this.config.provider.csrfToken) {
        parts.push(`csrftoken=${this.config.provider.csrfToken}`);
        headers['x-csrftoken'] = this.config.provider.csrfToken;
      }
      headers.Cookie = parts.join('; ');
    }

    return headers;
  }
}
