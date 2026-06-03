import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyCaptcha } from "./captcha";

// Observable contract for the Cloudflare Turnstile gate (step06).
// `fetch` is stubbed so these tests never reach Cloudflare. The siteverify
// secret is set inline (never via .env) for the cases that reach the network.

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("verifyCaptcha", () => {
  it("returns missing WITHOUT calling siteverify for a null/empty token (SCEN-002)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await verifyCaptcha(null)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyCaptcha("")).toEqual({ ok: false, reason: "missing" });
    expect(await verifyCaptcha("   ")).toEqual({
      ok: false,
      reason: "missing",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok when siteverify reports success (SCEN-004)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyCaptcha("good.DUMMY.TOKEN", "203.0.113.5");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SITEVERIFY_URL);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({
      secret: "1x0000000000000000000000000000000AA",
      response: "good.DUMMY.TOKEN",
      remoteip: "203.0.113.5",
    });
  });

  it("returns invalid when siteverify reports failure (SCEN-003)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyCaptcha("bad.DUMMY.TOKEN");

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("logs the siteverify error-codes on an invalid result (observability)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        success: false,
        "error-codes": ["invalid-input-response"],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await verifyCaptcha("bad.DUMMY.TOKEN");

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ errorCodes: ["invalid-input-response"] }),
    );
  });

  it("trims a whitespace-padded token once and sends the trimmed value (FIX 4)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyCaptcha("  good.DUMMY.TOKEN  ");

    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.response).toBe("good.DUMMY.TOKEN");
  });

  it("rejects an oversized token (>2048) as invalid WITHOUT calling fetch (FIX 4)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyCaptcha("x".repeat(2049));

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails CLOSED — returns error when fetch rejects (SCEN-007)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyCaptcha("any.DUMMY.TOKEN");

    expect(result).toEqual({ ok: false, reason: "error" });
    expect(error).toHaveBeenCalled();
  });

  it("throws a clear error when the secret env is missing", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyCaptcha("any.DUMMY.TOKEN")).rejects.toThrow(
      /TURNSTILE_SECRET_KEY/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
