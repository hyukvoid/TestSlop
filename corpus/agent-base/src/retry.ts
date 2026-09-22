export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Deterministic in tests; defaults to Math.random in production. */
  random?: () => number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
};

export interface Attempt {
  attempt: number;
  delayMs: number;
}

/** Exponential backoff with full jitter, capped at maxDelayMs. */
export function backoffDelay(attempt: number, options: RetryOptions): number {
  const random = options.random ?? Math.random;
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  return Math.floor(capped * random());
}

export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

export interface RetryResult<T> {
  value?: T;
  attempts: Attempt[];
  error?: unknown;
  succeeded: boolean;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RetryResult<T>> {
  const attempts: Attempt[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const value = await operation(attempt);
      attempts.push({ attempt, delayMs: 0 });
      return { value, attempts, succeeded: true };
    } catch (err) {
      lastError = err;
      const delayMs = attempt < options.maxAttempts ? backoffDelay(attempt, options) : 0;
      attempts.push({ attempt, delayMs });
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  return { attempts, error: lastError, succeeded: false };
}
