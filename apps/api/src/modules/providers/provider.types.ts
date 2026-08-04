/**
 * The data-provider contract.
 *
 * Business logic depends on *these* types and never on LeetCode. Everything below is
 * expressed in terms this programme cares about — "a student solved this problem at
 * this time" — rather than in the shape of any particular upstream API.
 *
 * Two constraints are baked into the contract because they are properties of the
 * problem, not of one implementation:
 *
 *  1. `fetchRecentSubmissions` returns a *window*, not a complete history, and reports
 *     whether the window may have been truncated. Any provider scraping a public feed
 *     has this property, and callers must handle it.
 *  2. Runtime and memory are optional. The public LeetCode endpoints do not expose
 *     them; a future authenticated provider might. Callers must not require them.
 */

import type { Difficulty, ProblemStatus } from '@dsa/shared';

/** A single submission as reported by a provider. */
export interface ProviderSubmission {
  /** Provider-unique submission id — the idempotency key for the local mirror. */
  id: string;
  titleSlug: string;
  title: string;
  status: ProblemStatus;
  submittedAt: Date;
  language: string | null;
  /** Not available from public LeetCode endpoints; present only if a provider can supply it. */
  runtime: string | null;
  memory: string | null;
}

export interface FetchSubmissionsOptions {
  /**
   * Stop walking once submissions are older than this. The incremental sync passes the
   * student's last known submission time so each cycle transfers only what is new.
   */
  since?: Date | null;
  /** Provider-side cap; implementations clamp to whatever the upstream actually allows. */
  limit?: number;
  /** When true, include non-accepted submissions. Costs window space, so it is opt-in. */
  includeNonAccepted?: boolean;
}

export interface ProviderSubmissionPage {
  submissions: ProviderSubmission[];
  /**
   * True when the provider's hard result cap was hit, meaning submissions older than
   * the oldest returned row may exist but are unreachable.
   *
   * This is not a detail — it is the reason the sync must run several times a day.
   * A student who solves more than the window size between two syncs will have
   * submissions that are permanently invisible to us.
   */
  truncated: boolean;
  /** The provider's hard cap, for logging and for sizing the sync interval. */
  windowSize: number;
  fetchedAt: Date;
}

/** All-time aggregate statistics for a user. */
export interface ProviderUserProfile {
  username: string;
  displayName: string | null;
  realName: string | null;
  avatarUrl: string | null;
  ranking: number | null;
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
}

export interface ProviderProblemMetadata {
  titleSlug: string;
  title: string;
  questionId: string | null;
  questionFrontendId: string | null;
  difficulty: Difficulty;
  acceptanceRate: number | null;
  isPaidOnly: boolean;
  topicTags: string[];
  /**
   * Premium-gated on LeetCode's public endpoint — verified to return `null`.
   * Always empty for the public provider; kept so an authenticated one can fill it.
   */
  companyTags: string[];
  url: string;
}

/**
 * The provider abstraction.
 *
 * Swapping implementations (a different scraper, an authenticated client, a vendor API,
 * or the in-memory fake used by tests) must require no change anywhere else.
 */
export interface SubmissionProvider {
  /** Stable identifier persisted alongside submissions, so mixed-provider data stays attributable. */
  readonly name: string;

  /**
   * Recent submissions for a user, newest first.
   * @throws {ProviderUserNotFoundError} when the username does not exist.
   */
  fetchRecentSubmissions(
    username: string,
    options?: FetchSubmissionsOptions,
  ): Promise<ProviderSubmissionPage>;

  /**
   * Accepted submissions only — the spec's `fetchSolvedProblems`.
   * A convenience over `fetchRecentSubmissions`, kept in the contract because it is
   * the call the sync engine actually makes.
   */
  fetchSolvedProblems(
    username: string,
    options?: FetchSubmissionsOptions,
  ): Promise<ProviderSubmissionPage>;

  /**
   * The user's most recent submission for one problem, or `null` if they never
   * submitted to it within the reachable window.
   */
  fetchSubmission(username: string, problemSlug: string): Promise<ProviderSubmission | null>;

  /** Aggregate profile statistics. */
  fetchUserProfile(username: string): Promise<ProviderUserProfile>;

  /** Problem metadata for assignment auto-fill. */
  fetchProblemMetadata(problemSlug: string): Promise<ProviderProblemMetadata>;

  /** Cheap liveness probe used by the health endpoint. */
  healthCheck(): Promise<boolean>;
}

/** DI token — consumers inject the interface, never a concrete class. */
export const SUBMISSION_PROVIDER = Symbol('SUBMISSION_PROVIDER');
