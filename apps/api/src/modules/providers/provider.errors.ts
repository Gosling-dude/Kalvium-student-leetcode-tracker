/**
 * Provider failure taxonomy.
 *
 * Each error carries the `SyncStatus` it should be recorded as, so the sync engine
 * never has to pattern-match on messages, and every zero shown to a mentor traces back
 * to a specific, explainable cause.
 *
 * `retryable` is the other half: transient network and throttling failures are worth
 * another attempt, a misspelled username never is. Retrying non-retryable errors at
 * 250 students would waste an entire sync window.
 */

import type { SyncStatus } from '@dsa/shared';

export abstract class ProviderError extends Error {
  abstract readonly syncStatus: SyncStatus;
  abstract readonly retryable: boolean;

  protected constructor(
    message: string,
    readonly username?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The username does not exist upstream — almost always a typo in the import sheet. */
export class ProviderUserNotFoundError extends ProviderError {
  readonly syncStatus: SyncStatus = 'USER_NOT_FOUND';
  readonly retryable = false;

  constructor(username: string) {
    super(`LeetCode user "${username}" does not exist`, username);
  }
}

/** The account exists but its submission feed is not publicly readable. */
export class ProviderProfilePrivateError extends ProviderError {
  readonly syncStatus: SyncStatus = 'PROFILE_PRIVATE';
  readonly retryable = false;

  constructor(username: string) {
    super(`LeetCode profile for "${username}" is not publicly visible`, username);
  }
}

/** Upstream throttled us. Retryable, but the backoff must be generous. */
export class ProviderRateLimitedError extends ProviderError {
  readonly syncStatus: SyncStatus = 'RATE_LIMITED';
  readonly retryable = true;

  constructor(
    message = 'Rate limited by provider',
    username?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message, username);
  }
}

export class ProviderTimeoutError extends ProviderError {
  readonly syncStatus: SyncStatus = 'TIMEOUT';
  readonly retryable = true;

  constructor(username?: string, cause?: unknown) {
    super('Provider request timed out', username, cause);
  }
}

/** Anything else: 5xx, malformed payloads, transport failures. */
export class ProviderRequestError extends ProviderError {
  readonly syncStatus: SyncStatus = 'PROVIDER_ERROR';
  readonly retryable: boolean;

  constructor(message: string, username?: string, cause?: unknown, retryable = true) {
    super(message, username, cause);
    this.retryable = retryable;
  }
}

/** A requested problem slug does not exist upstream. Never retryable. */
export class ProviderProblemNotFoundError extends ProviderError {
  readonly syncStatus: SyncStatus = 'PROVIDER_ERROR';
  readonly retryable = false;

  constructor(readonly slug: string) {
    super(`LeetCode problem "${slug}" was not found`);
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Map any thrown value to the status it should be recorded under. */
export function toSyncStatus(error: unknown): SyncStatus {
  if (isProviderError(error)) return error.syncStatus;
  return 'PROVIDER_ERROR';
}

export function isRetryable(error: unknown): boolean {
  if (isProviderError(error)) return error.retryable;
  // Unknown failures are assumed transient — a bounded retry is cheaper than
  // silently dropping a student from the day's report.
  return true;
}
