/**
 * Token-bucket rate limiter with bounded concurrency.
 *
 * LeetCode publishes no rate limit and offers no support channel, so the cost of being
 * throttled is a lost sync cycle with no recourse. This limiter is therefore applied to
 * *every* outbound provider call, and both dimensions matter:
 *
 *  - **Rate** (tokens/second) bounds the long-run request rate.
 *  - **Concurrency** bounds simultaneous in-flight requests, which rate alone does not:
 *    4 req/s with unbounded concurrency can still open 50 sockets if the server is slow.
 *
 * Waiters are served strictly first-in-first-out so that no student's sync can be
 * starved by a continuous stream of newer requests.
 */

export interface RateLimiterOptions {
  requestsPerSecond: number;
  concurrency: number;
  /** Burst allowance. Defaults to one second's worth of tokens. */
  burst?: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;
  private active = 0;
  private readonly queue: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private readonly options: RateLimiterOptions) {
    const rate = Math.max(0.1, options.requestsPerSecond);
    this.capacity = Math.max(1, options.burst ?? Math.ceil(rate));
    this.tokens = this.capacity;
    this.refillPerMs = rate / 1000;
    this.lastRefill = Date.now();
  }

  /** Run `fn` once a token and a concurrency slot are available. */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('RateLimiter has been destroyed'));

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.drain();
    });
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  private drain(): void {
    this.refill();

    while (
      this.queue.length > 0 &&
      this.active < this.options.concurrency &&
      this.tokens >= 1
    ) {
      const waiter = this.queue.shift()!;
      this.tokens -= 1;
      this.active += 1;
      waiter.resolve();
    }

    // Something is still waiting. If it is waiting on tokens (rather than on a
    // concurrency slot, which a `release()` will signal), wake up when the next
    // token is due rather than busy-looping.
    if (this.queue.length > 0 && this.active < this.options.concurrency && !this.timer) {
      const msUntilToken = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, msUntilToken);
      // Never hold the process open just to refill a bucket.
      this.timer.unref?.();
    }
  }

  /** Snapshot for the queue-health endpoint. */
  stats(): { queued: number; active: number; availableTokens: number } {
    this.refill();
    return {
      queued: this.queue.length,
      active: this.active,
      availableTokens: Math.floor(this.tokens),
    };
  }

  /** Reject everything still waiting. Used on shutdown so we never hang the process. */
  destroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(new Error('RateLimiter destroyed while request was queued'));
    }
  }
}

export interface RetryOptions {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** Decides whether a given failure is worth another attempt. */
  isRetryable: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Retry with exponential backoff and full jitter.
 *
 * Full jitter (a uniform random delay in `[0, backoff]`) rather than fixed backoff:
 * with hundreds of students syncing together, synchronised retries would arrive as a
 * thundering herd and re-trigger the very throttling we are backing off from.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= options.maxRetries || !options.isRetryable(error)) break;

      const exponential = Math.min(
        options.maxBackoffMs,
        options.initialBackoffMs * 2 ** attempt,
      );
      // Honour an explicit Retry-After when the provider sent one.
      const retryAfter =
        typeof (error as { retryAfterMs?: number })?.retryAfterMs === 'number'
          ? (error as { retryAfterMs: number }).retryAfterMs
          : null;
      const delay = retryAfter ?? Math.floor(Math.random() * exponential);

      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
