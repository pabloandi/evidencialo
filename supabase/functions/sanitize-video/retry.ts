/**
 * Portable exponential-backoff retry helper (no Deno/Node imports — runnable in
 * vitest AND the Deno Edge runtime).
 *
 * Wraps a transient I/O operation (storage download/upload). Retries on ANY
 * throw, waiting `baseDelayMs * 2^(attempt-1)` between tries, and re-throws the
 * LAST error once the attempt budget is exhausted so the caller can mark the
 * media `'failed'` (SCEN-005). Deterministic faults (mp4 parse) are NOT wrapped
 * in this helper by the caller — they are terminal on the first throw.
 */
export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base backoff in ms; doubles each retry. Default 200. */
  baseDelayMs?: number;
  /**
   * Predicate deciding whether a thrown error is worth retrying. Returning
   * false re-raises immediately (no backoff, no further attempts) — used to
   * short-circuit DETERMINISTIC faults like a storage not-found, which would
   * just waste the budget. Defaults to "retry everything".
   */
  shouldRetry?: (error: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Deterministic faults re-raise immediately — no backoff, no more tries.
      if (!shouldRetry(error)) throw error;
      if (attempt < attempts) {
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}
