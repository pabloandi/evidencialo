import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/reports/[id]/validate (A2).
// validateReport + getSessionRole + the two anti-spam gates + ipHash are mocked
// so the route's ORDER and branch logic is the unit under test:
//   malformed id -> 400 (gates not reached)
//   over the rate limit -> 429 (captcha + service NOT called)
//   anonymous, no captcha -> 403 captcha_required (service NOT called)
//   anonymous + valid captcha, newly added -> 201 (ip_hash forwarded)
//   authenticated, newly added -> 201 (no captcha, null ip_hash)
//   idempotent re-confirm (newly_added=false) -> 200
//   ReportNotValidatableError -> 409 not_validatable

const getSessionRoleMock = vi.fn();
const checkRateLimitMock = vi.fn();
const verifyCaptchaMock = vi.fn();
const validateReportMock = vi.fn();
const ipHashMock = vi.fn();

vi.mock("@/lib/services/authz", () => ({
  getSessionRole: (...args: unknown[]) => getSessionRoleMock(...args),
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

vi.mock("@/lib/captcha", () => ({
  verifyCaptcha: (...args: unknown[]) => verifyCaptchaMock(...args),
}));

vi.mock("@/lib/http/ipHash", () => ({
  ipHash: (...args: unknown[]) => ipHashMock(...args),
}));

vi.mock("@/lib/services/validationService", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/services/validationService")>(
      "@/lib/services/validationService",
    );
  return {
    ...actual,
    validateReport: (...args: unknown[]) => validateReportMock(...args),
  };
});

import { ReportNotValidatableError } from "@/lib/services/validationService";
import { POST } from "./route";

const VALID_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VALID_TOKEN = "valid.DUMMY.TOKEN";
const FAKE_HASH = "hashed-ip-value";

function makeRequest(id: string, headers: Record<string, string> = {}) {
  return {
    request: new Request(`http://localhost/api/reports/${id}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  getSessionRoleMock.mockReset();
  checkRateLimitMock.mockReset();
  verifyCaptchaMock.mockReset();
  validateReportMock.mockReset();
  ipHashMock.mockReset();

  // Defaults: anonymous, under the limit, valid captcha, stable hash. Cases override.
  getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  verifyCaptchaMock.mockResolvedValue({ ok: true });
  ipHashMock.mockReturnValue(FAKE_HASH);
});

describe("POST /api/reports/[id]/validate", () => {
  it("returns 400 for a malformed id without touching the gates or service", async () => {
    const { request, ctx } = makeRequest("not-a-uuid");

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("id_invalid");
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(validateReportMock).not.toHaveBeenCalled();
  });

  it("rejects a caller over the rate limit with 429, before captcha and service", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false });
    const { request, ctx } = makeRequest(VALID_ID, {
      "cf-turnstile-response": VALID_TOKEN,
      "x-forwarded-for": "203.0.113.5",
    });

    const res = await POST(request, ctx);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("rate_limited");
    expect(verifyCaptchaMock).not.toHaveBeenCalled();
    expect(validateReportMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith("ip:203.0.113.5");
  });

  it("rejects an anonymous caller with a missing captcha token with 403 captcha_required", async () => {
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "missing" });
    const { request, ctx } = makeRequest(VALID_ID);

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_required");
    expect(validateReportMock).not.toHaveBeenCalled();
  });

  it("returns 201 for an anonymous caller with a valid captcha, forwarding the hashed ip", async () => {
    validateReportMock.mockResolvedValue({
      verifiedCount: 2,
      anonCount: 5,
      newlyAdded: true,
    });
    const { request, ctx } = makeRequest(VALID_ID, {
      "cf-turnstile-response": VALID_TOKEN,
      "x-forwarded-for": "203.0.113.5",
    });

    const res = await POST(request, ctx);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      verifiedCount: 2,
      anonCount: 5,
      corroborated: false,
    });
    expect(ipHashMock).toHaveBeenCalledWith("203.0.113.5");
    expect(validateReportMock).toHaveBeenCalledWith(VALID_ID, FAKE_HASH);
  });

  it("skips captcha for an authenticated caller, keys the limit by user id, and sends a null ip_hash", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-7", role: "citizen" });
    validateReportMock.mockResolvedValue({
      verifiedCount: 3,
      anonCount: 0,
      newlyAdded: true,
    });
    const { request, ctx } = makeRequest(VALID_ID);

    const res = await POST(request, ctx);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      verifiedCount: 3,
      anonCount: 0,
      corroborated: true,
    });
    expect(verifyCaptchaMock).not.toHaveBeenCalled();
    expect(ipHashMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith("user:u-7");
    expect(validateReportMock).toHaveBeenCalledWith(VALID_ID, null);
  });

  it("returns 200 for an idempotent re-confirm (newly_added=false)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-7", role: "citizen" });
    validateReportMock.mockResolvedValue({
      verifiedCount: 3,
      anonCount: 0,
      newlyAdded: false,
    });
    const { request, ctx } = makeRequest(VALID_ID);

    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      verifiedCount: 3,
      anonCount: 0,
      corroborated: true,
    });
  });

  it("returns 409 not_validatable when the report is not open/visible", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-7", role: "citizen" });
    validateReportMock.mockRejectedValue(new ReportNotValidatableError());
    const { request, ctx } = makeRequest(VALID_ID);

    const res = await POST(request, ctx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("not_validatable");
  });

  it("returns 500 internal_error for an unexpected service failure", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-7", role: "citizen" });
    validateReportMock.mockRejectedValue(new Error("db is on fire"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID);

    const res = await POST(request, ctx);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("treats a getSessionRole throw as anonymous (captcha-walled), not 500", async () => {
    getSessionRoleMock.mockRejectedValue(new Error("supabase boom"));
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "missing" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID);

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_required");
    expect(validateReportMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
