import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Rate-limit gate for POST /api/reports (step06, design §5.2 — runs FIRST).
 *
 * Identifier is `user:<id>` for a session, else `ip:<client-ip>`. The limiter is
 * an env-backed Upstash sliding window, built lazily on first use so importing
 * this module never requires Redis env (e.g. in tests, build).
 *
 * FAILS OPEN: a Redis/REST outage (or missing env that prevents building the
 * limiter) must NOT take the endpoint down — captcha still walls anonymous
 * writes. Any error from `.limit()` is logged and treated as allowed (SCEN-008).
 */

/** Minimal limiter surface so tests can inject a fake. */
export type RateLimiterLike = {
  limit(identifier: string): Promise<{ success: boolean }>;
};

type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW: Duration = "10 m";

let cached: RateLimiterLike | null = null;

/**
 * Mirrors the Upstash `ms()` parser regex (`@upstash/ratelimit` -> `ms`). A
 * window the parser rejects throws inside `Ratelimit.slidingWindow()` at
 * CONSTRUCTION time, which would prevent the singleton from ever building and
 * silently fail the limiter OPEN forever. We pre-validate so a config typo
 * falls back to the safe default instead (FIX 1).
 */
const WINDOW_RE = /^\d+\s?(ms|s|m|h|d)$/;

/** Parse RATE_LIMIT_MAX; fall back to the default for unset/invalid values. */
function resolveMax(): number {
  const raw = process.env.RATE_LIMIT_MAX;
  if (!raw) return DEFAULT_MAX;
  const parsed = Number.parseInt(raw, 10);
  // Floor at >= 1: 0, negative, or NaN would disable/neuter the limit.
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX;
}

/**
 * Read RATE_LIMIT_WINDOW; fall back to the default for unset OR malformed
 * values (anything the Upstash `ms()` parser would reject, plus a zero-count
 * window like "0 m" which is a useless config). NEVER let a bad string reach
 * `slidingWindow()` and throw (FIX 1).
 */
function resolveWindow(): Duration {
  const raw = process.env.RATE_LIMIT_WINDOW?.trim();
  if (raw && WINDOW_RE.test(raw) && !/^0+\s?/.test(raw)) {
    return raw as Duration;
  }
  return DEFAULT_WINDOW;
}

/**
 * Build a fresh env-backed Upstash limiter. `Redis.fromEnv()` reads
 * `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` and throws if absent;
 * the window/max are pre-validated above so `slidingWindow()` never throws on a
 * config typo. Exported for construction-time tests (FIX 1).
 */
export function buildLimiter(): RateLimiterLike {
  return new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(resolveMax(), resolveWindow()),
    prefix: "evidencialo:reports",
  });
}

/** Lazily build + cache the singleton limiter. */
function getLimiter(): RateLimiterLike {
  if (cached) return cached;
  cached = buildLimiter();
  return cached;
}

export async function checkRateLimit(
  identifier: string,
  limiter?: RateLimiterLike,
): Promise<{ allowed: boolean }> {
  try {
    const rl = limiter ?? getLimiter();
    const { success } = await rl.limit(identifier);
    return { allowed: success };
  } catch (error) {
    // Fail open: never let a limiter outage 500 the endpoint (SCEN-008).
    console.warn("Rate-limit check failed; allowing request (fail-open)", {
      identifier,
      error,
    });
    return { allowed: true };
  }
}
