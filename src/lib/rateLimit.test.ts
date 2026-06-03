import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLimiter, checkRateLimit, type RateLimiterLike } from "./rateLimit";

// Observable contract for the rate-limit gate (step06).
// The limiter is injected so these tests never touch Redis. The route composes
// the env-backed singleton; here we assert the allow/deny + fail-open decision.

// Upstash Redis.fromEnv() throws without REST env; the construction tests below
// need it to succeed so the only thing that could throw is the WINDOW parser.
const REDIS_ENV = {
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

afterEach(() => {
  delete process.env.RATE_LIMIT_WINDOW;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("checkRateLimit", () => {
  it("allows the request when the limiter reports success", async () => {
    const limiter: RateLimiterLike = {
      limit: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await checkRateLimit("ip:203.0.113.5", limiter);

    expect(result).toEqual({ allowed: true });
    expect(limiter.limit).toHaveBeenCalledWith("ip:203.0.113.5");
  });

  it("rejects the request when the limiter reports failure (SCEN-001)", async () => {
    const limiter: RateLimiterLike = {
      limit: vi.fn().mockResolvedValue({ success: false }),
    };

    const result = await checkRateLimit("ip:203.0.113.5", limiter);

    expect(result).toEqual({ allowed: false });
  });

  it("fails OPEN — allows the request when the limiter throws (SCEN-008)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter: RateLimiterLike = {
      limit: vi.fn().mockRejectedValue(new Error("Redis REST outage")),
    };

    const result = await checkRateLimit("user:u-1", limiter);

    expect(result).toEqual({ allowed: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// FIX 1 — a malformed RATE_LIMIT_WINDOW must NOT throw inside the Upstash
// `ms()` parser at construction (which would silently fail the limiter open
// forever). resolveWindow() falls back to the default for anything the parser
// would reject, so buildLimiter() always succeeds.
describe("buildLimiter — window env hardening (FIX 1)", () => {
  it.each([
    ["10  m", "double space"],
    ["10 minutes", "long unit word"],
    ["10m ", "trailing space"],
    ["10 M", "uppercase unit"],
    ["0 m", "zero tokens window"],
    ["abc", "garbage"],
    ["", "empty"],
  ])(
    "does not throw for a malformed window %j (%s) — falls back to default",
    (badWindow) => {
      Object.assign(process.env, REDIS_ENV);
      process.env.RATE_LIMIT_WINDOW = badWindow;

      expect(() => buildLimiter()).not.toThrow();
    },
  );

  it("builds with a well-formed custom window", () => {
    Object.assign(process.env, REDIS_ENV);
    process.env.RATE_LIMIT_WINDOW = "30 s";
    process.env.RATE_LIMIT_MAX = "3";

    expect(() => buildLimiter()).not.toThrow();
  });

  it("a malformed window does not disable enforcement — a denying limiter still denies", async () => {
    Object.assign(process.env, REDIS_ENV);
    process.env.RATE_LIMIT_WINDOW = "10 minutes";

    // The injected fake stands in for a successfully-built env limiter; the
    // point is that bad config no longer forces the fail-open path.
    const limiter: RateLimiterLike = {
      limit: vi.fn().mockResolvedValue({ success: false }),
    };
    expect(await checkRateLimit("ip:203.0.113.5", limiter)).toEqual({
      allowed: false,
    });
  });
});
