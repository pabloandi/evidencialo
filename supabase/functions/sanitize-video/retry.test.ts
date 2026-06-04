import { describe, expect, it, vi } from "vitest";

import { withRetry } from "./retry";

/**
 * SCEN-005 — transient I/O is retried with backoff; persistent failure gives up.
 * Tiny baseDelayMs keeps the suite fast without needing fake timers.
 */
describe("withRetry (SCEN-005)", () => {
  it("heals: fails once then succeeds, returning the value (was retried)", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient EIO"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { attempts: 3, baseDelayMs: 1 });

    expect(result).toBe("ok");
    expect(fn.mock.calls.length).toBeGreaterThan(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("persistent failure: rejects after EXACTLY N attempts, surfacing the last error", async () => {
    const fn = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("persistent EIO"));

    await expect(
      withRetry(fn, { attempts: 3, baseDelayMs: 1 }),
    ).rejects.toThrow("persistent EIO");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("succeeds on the first try without extra calls", async () => {
    const fn = vi.fn<() => Promise<number>>().mockResolvedValue(42);
    await expect(withRetry(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("defaults to 3 attempts when opts omitted", async () => {
    const fn = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("boom"));
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("shouldRetry=false short-circuits a deterministic error (NOT retried)", async () => {
    // A not-found is deterministic: retrying with backoff is wasted work. The
    // predicate lets the caller re-raise it immediately after ONE attempt
    // (SCEN-H01 — the missing-object download must not burn the retry budget).
    class NotFound extends Error {}
    const fn = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new NotFound("missing"));
    await expect(
      withRetry(fn, {
        attempts: 3,
        baseDelayMs: 1,
        shouldRetry: (e) => !(e instanceof NotFound),
      }),
    ).rejects.toBeInstanceOf(NotFound);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("shouldRetry=true still retries transient errors normally", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    await expect(
      withRetry(fn, { attempts: 3, baseDelayMs: 1, shouldRetry: () => true }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
