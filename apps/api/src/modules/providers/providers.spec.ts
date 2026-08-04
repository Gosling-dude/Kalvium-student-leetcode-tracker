import { describe, expect, it } from 'vitest';

import { RateLimiter, retryWithBackoff, sleep } from './rate-limiter';
import {
  ProviderProfilePrivateError,
  ProviderRateLimitedError,
  ProviderRequestError,
  ProviderTimeoutError,
  ProviderUserNotFoundError,
  isRetryable,
  toSyncStatus,
} from './provider.errors';
import { FakeSubmissionProvider } from './fake/fake.provider';

describe('RateLimiter', () => {
  it('never exceeds the configured concurrency', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1000, concurrency: 3 });
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.schedule(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(5);
          active -= 1;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    limiter.destroy();
  });

  it('throttles throughput to roughly the configured rate', async () => {
    // 10/s with a burst of 2: 6 requests must take at least ~400ms.
    const limiter = new RateLimiter({ requestsPerSecond: 10, concurrency: 10, burst: 2 });
    const start = Date.now();

    await Promise.all(Array.from({ length: 6 }, () => limiter.schedule(async () => undefined)));

    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
    limiter.destroy();
  });

  it('releases its slot even when the task throws', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1000, concurrency: 1 });

    await expect(
      limiter.schedule(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // If the slot leaked, this would hang rather than resolve.
    await expect(limiter.schedule(async () => 'ok')).resolves.toBe('ok');
    limiter.destroy();
  });

  it('reports queue depth', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1000, concurrency: 2 });
    const stats = limiter.stats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    limiter.destroy();
  });

  it('rejects queued work when destroyed rather than hanging', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 0.1, concurrency: 1, burst: 1 });
    void limiter.schedule(() => sleep(50));
    const queued = limiter.schedule(async () => 'never');
    limiter.destroy();
    await expect(queued).rejects.toThrow(/destroyed/i);
  });
});

describe('retryWithBackoff', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        return 'ok';
      },
      { maxRetries: 3, initialBackoffMs: 1, maxBackoffMs: 2, isRetryable },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a retryable failure and eventually succeeds', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new ProviderTimeoutError('someone');
        return 'recovered';
      },
      { maxRetries: 5, initialBackoffMs: 1, maxBackoffMs: 2, isRetryable },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('does not retry a non-retryable failure', async () => {
    // A misspelled username fails identically every time; retrying it at 250 students
    // would burn the whole retry budget for nothing.
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new ProviderUserNotFoundError('ghost');
        },
        { maxRetries: 4, initialBackoffMs: 1, maxBackoffMs: 2, isRetryable },
      ),
    ).rejects.toBeInstanceOf(ProviderUserNotFoundError);

    expect(calls).toBe(1);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new ProviderTimeoutError();
        },
        { maxRetries: 2, initialBackoffMs: 1, maxBackoffMs: 2, isRetryable },
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);

    expect(calls).toBe(3); // the initial attempt plus two retries
  });
});

describe('error taxonomy', () => {
  it('maps each failure to the status a mentor will see', () => {
    expect(toSyncStatus(new ProviderUserNotFoundError('x'))).toBe('USER_NOT_FOUND');
    expect(toSyncStatus(new ProviderProfilePrivateError('x'))).toBe('PROFILE_PRIVATE');
    expect(toSyncStatus(new ProviderRateLimitedError())).toBe('RATE_LIMITED');
    expect(toSyncStatus(new ProviderTimeoutError())).toBe('TIMEOUT');
    expect(toSyncStatus(new ProviderRequestError('boom'))).toBe('PROVIDER_ERROR');
  });

  it('treats unknown throwables as retryable, so a blip does not drop a student', () => {
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
  });

  it('marks data-quality failures as permanent', () => {
    expect(isRetryable(new ProviderUserNotFoundError('x'))).toBe(false);
    expect(isRetryable(new ProviderProfilePrivateError('x'))).toBe(false);
  });
});

describe('FakeSubmissionProvider — provider contract', () => {
  const at = (iso: string): Date => new Date(iso);

  function provider(): FakeSubmissionProvider {
    const fake = new FakeSubmissionProvider();
    fake.setUser('asha', {
      submissions: [
        { titleSlug: 'two-sum', submittedAt: at('2026-08-04T04:00:00Z') },
        { titleSlug: 'lru-cache', submittedAt: at('2026-08-04T05:00:00Z') },
        {
          titleSlug: 'merge-intervals',
          submittedAt: at('2026-08-04T06:00:00Z'),
          status: 'ATTEMPTED_NOT_ACCEPTED',
        },
      ],
    });
    return fake;
  }

  it('returns submissions newest-first', async () => {
    const page = await provider().fetchRecentSubmissions('asha');
    expect(page.submissions[0]?.titleSlug).toBe('merge-intervals');
    expect(page.submissions.at(-1)?.titleSlug).toBe('two-sum');
  });

  it('filters to accepted submissions only for fetchSolvedProblems', async () => {
    const page = await provider().fetchSolvedProblems('asha');
    expect(page.submissions.map((s) => s.titleSlug).sort()).toEqual(['lru-cache', 'two-sum']);
  });

  it('honours the since cursor so a sync transfers only what is new', async () => {
    const page = await provider().fetchRecentSubmissions('asha', {
      since: at('2026-08-04T04:30:00Z'),
    });
    expect(page.submissions).toHaveLength(2);
    expect(page.submissions.every((s) => s.submittedAt > at('2026-08-04T04:30:00Z'))).toBe(true);
  });

  it('reports truncation when the provider window is full', async () => {
    // Reproduces the property that forces frequent syncs: 25 solves cannot fit a
    // 20-row window, and the caller must be told the older ones are unreachable.
    const fake = new FakeSubmissionProvider();
    fake.setUser('busy', {
      submissions: Array.from({ length: 25 }, (_, i) => ({
        titleSlug: `problem-${i}`,
        submittedAt: new Date(Date.UTC(2026, 7, 4, 0, i)),
      })),
    });

    const page = await fake.fetchRecentSubmissions('busy');
    expect(page.submissions).toHaveLength(20);
    expect(page.truncated).toBe(true);
    expect(page.windowSize).toBe(20);
  });

  it('does not report truncation when everything fits', async () => {
    const page = await provider().fetchRecentSubmissions('asha');
    expect(page.truncated).toBe(false);
  });

  it('produces stable submission ids so a re-sync is idempotent', async () => {
    const fake = provider();
    const first = await fake.fetchRecentSubmissions('asha');
    const second = await fake.fetchRecentSubmissions('asha');
    expect(first.submissions.map((s) => s.id)).toEqual(second.submissions.map((s) => s.id));
  });

  it('never invents runtime or memory, which the real provider cannot supply', async () => {
    const page = await provider().fetchRecentSubmissions('asha');
    expect(page.submissions.every((s) => s.runtime === null && s.memory === null)).toBe(true);
  });

  it('raises USER_NOT_FOUND for an unknown handle', async () => {
    await expect(provider().fetchRecentSubmissions('nobody')).rejects.toBeInstanceOf(
      ProviderUserNotFoundError,
    );
  });

  it('reproduces each simulated failure mode', async () => {
    const fake = new FakeSubmissionProvider();
    fake.setUser('private', { submissions: [], failure: 'PRIVATE' });
    fake.setUser('limited', { submissions: [], failure: 'RATE_LIMITED' });
    fake.setUser('slow', { submissions: [], failure: 'TIMEOUT' });

    await expect(fake.fetchUserProfile('private')).rejects.toBeInstanceOf(
      ProviderProfilePrivateError,
    );
    await expect(fake.fetchUserProfile('limited')).rejects.toBeInstanceOf(
      ProviderRateLimitedError,
    );
    await expect(fake.fetchUserProfile('slow')).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('counts unique accepted problems in the profile', async () => {
    const profile = await provider().fetchUserProfile('asha');
    expect(profile.totalSolved).toBe(2);
  });

  it('resolves problem metadata for a plausible slug', async () => {
    const metadata = await provider().fetchProblemMetadata('two-sum');
    expect(metadata.title).toBe('Two Sum');
    expect(metadata.url).toContain('two-sum');
    // Company tags are premium-gated upstream; the fake mirrors that they stay empty.
    expect(metadata.companyTags).toEqual([]);
  });
});
