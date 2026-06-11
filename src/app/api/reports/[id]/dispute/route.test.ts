import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/reports/[id]/dispute (B3.2).
// fileDispute + getSessionRole + the two anti-spam gates are mocked so the
// route's ORDER and branch logic is the unit under test:
//   malformed id -> 400 (gates not reached)
//   over the rate limit -> 429 (captcha + service NOT called)
//   anonymous, no captcha -> 403 captcha_required (service NOT called)
//   invalid body (reason too long) -> 400 (service NOT called)
//   success -> 201 { dispute: { id } }
//   DisputeExistsError -> 409 dispute_exists
//   ReportNotDisputableError -> 409 not_disputable
//   unexpected -> 500 internal_error

const getSessionRoleMock = vi.fn();
const checkRateLimitMock = vi.fn();
const verifyCaptchaMock = vi.fn();
const fileDisputeMock = vi.fn();

vi.mock("@/lib/services/authz", () => ({
  getSessionRole: (...args: unknown[]) => getSessionRoleMock(...args),
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

vi.mock("@/lib/captcha", () => ({
  verifyCaptcha: (...args: unknown[]) => verifyCaptchaMock(...args),
}));

vi.mock("@/lib/services/disputeService", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/services/disputeService")>(
      "@/lib/services/disputeService",
    );
  return {
    ...actual,
    fileDispute: (...args: unknown[]) => fileDisputeMock(...args),
  };
});

import {
  DisputeExistsError,
  ReportNotDisputableError,
} from "@/lib/services/disputeService";
import { POST } from "./route";

const VALID_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VALID_TOKEN = "valid.DUMMY.TOKEN";

function makeRequest(
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    request: new Request(`http://localhost/api/reports/${id}/dispute`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  getSessionRoleMock.mockReset();
  checkRateLimitMock.mockReset();
  verifyCaptchaMock.mockReset();
  fileDisputeMock.mockReset();

  // Defaults: anonymous, under the limit, valid captcha. Cases override.
  getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  verifyCaptchaMock.mockResolvedValue({ ok: true });
});

describe("POST /api/reports/[id]/dispute", () => {
  it("returns 400 for a malformed id without touching the gates or service", async () => {
    const { request, ctx } = makeRequest("not-a-uuid", { reason: "x" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("id_invalid");
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(fileDisputeMock).not.toHaveBeenCalled();
  });

  it("rejects a caller over the rate limit with 429, before captcha and service", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false });
    const { request, ctx } = makeRequest(
      VALID_ID,
      { reason: "x" },
      { "cf-turnstile-response": VALID_TOKEN, "x-forwarded-for": "203.0.113.5" },
    );

    const res = await POST(request, ctx);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("rate_limited");
    expect(verifyCaptchaMock).not.toHaveBeenCalled();
    expect(fileDisputeMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith("ip:203.0.113.5");
  });

  it("rejects an anonymous caller with a missing captcha token with 403 captcha_required", async () => {
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "missing" });
    const { request, ctx } = makeRequest(VALID_ID, { reason: "x" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_required");
    expect(fileDisputeMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous caller with an invalid captcha token with 403 captcha_invalid", async () => {
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "invalid" });
    const { request, ctx } = makeRequest(
      VALID_ID,
      { reason: "x" },
      { "cf-turnstile-response": "bad.TOKEN" },
    );

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_invalid");
    expect(fileDisputeMock).not.toHaveBeenCalled();
  });

  it("skips captcha for an authenticated caller and keys the rate limit by user id", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-7", role: "citizen" });
    fileDisputeMock.mockResolvedValue({ id: "disp-1" });
    const { request, ctx } = makeRequest(VALID_ID, { reason: "es falso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(201);
    expect(verifyCaptchaMock).not.toHaveBeenCalled();
    expect(checkRateLimitMock).toHaveBeenCalledWith("user:u-7");
    expect(fileDisputeMock).toHaveBeenCalledWith(VALID_ID, "es falso", "u-7");
  });

  it("returns 400 for an over-long reason and never calls the service", async () => {
    const { request, ctx } = makeRequest(
      VALID_ID,
      { reason: "x".repeat(1001) },
      { "cf-turnstile-response": VALID_TOKEN },
    );

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("reason_too_long");
    expect(fileDisputeMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unparseable body", async () => {
    const { request, ctx } = makeRequest(VALID_ID, "{not json", {
      "cf-turnstile-response": VALID_TOKEN,
    });

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
    expect(fileDisputeMock).not.toHaveBeenCalled();
  });

  it("returns 201 with the new dispute id on success, forwarding reason=null when omitted", async () => {
    fileDisputeMock.mockResolvedValue({ id: "disp-1" });
    const { request, ctx } = makeRequest(
      VALID_ID,
      {},
      { "cf-turnstile-response": VALID_TOKEN },
    );

    const res = await POST(request, ctx);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ dispute: { id: "disp-1" } });
    expect(fileDisputeMock).toHaveBeenCalledWith(VALID_ID, null, null);
  });

  it("returns 409 dispute_exists when the service reports a duplicate open dispute", async () => {
    fileDisputeMock.mockRejectedValue(new DisputeExistsError());
    const { request, ctx } = makeRequest(
      VALID_ID,
      { reason: "x" },
      { "cf-turnstile-response": VALID_TOKEN },
    );

    const res = await POST(request, ctx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("dispute_exists");
  });

  it("returns 409 not_disputable when the report is not resuelto (RLS rejection)", async () => {
    fileDisputeMock.mockRejectedValue(new ReportNotDisputableError());
    const { request, ctx } = makeRequest(
      VALID_ID,
      { reason: "x" },
      { "cf-turnstile-response": VALID_TOKEN },
    );

    const res = await POST(request, ctx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("not_disputable");
  });

  it("returns 500 internal_error for an unexpected service failure", async () => {
    fileDisputeMock.mockRejectedValue(new Error("db is on fire"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(
      VALID_ID,
      { reason: "x" },
      { "cf-turnstile-response": VALID_TOKEN },
    );

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
    const { request, ctx } = makeRequest(VALID_ID, { reason: "x" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_required");
    expect(fileDisputeMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
