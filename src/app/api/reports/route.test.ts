import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/reports.
// step05: validation runs for real; createReport is mocked to assert status
// codes and response body mapping (happy path, idempotent replay, errors).
// step06: the two anti-spam gates (rate-limit + captcha) and session detection
// are mocked so the route's ORDER and branch logic is the unit under test.

const createReportMock = vi.fn();
const getSessionRoleMock = vi.fn();
const checkRateLimitMock = vi.fn();
const verifyCaptchaMock = vi.fn();

vi.mock("@/lib/services/reportService", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/reportService")
  >("@/lib/services/reportService");
  return {
    ...actual,
    createReport: (...args: unknown[]) => createReportMock(...args),
  };
});

vi.mock("@/lib/services/authz", () => ({
  getSessionRole: (...args: unknown[]) => getSessionRoleMock(...args),
}));

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

vi.mock("@/lib/captcha", () => ({
  verifyCaptcha: (...args: unknown[]) => verifyCaptchaMock(...args),
}));

import { CategoryInvalidError } from "@/lib/services/reportService";
import { POST } from "./route";

const baseline = {
  category: "bache",
  lat: 4.6097,
  lng: -74.0817,
  description: "Bache profundo frente al colegio, peligroso para motos.",
  media: [{ type: "image", mime: "image/jpeg", size: 2000000 }],
};

const VALID_TOKEN = "valid.DUMMY.TOKEN";

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mockCreateSuccess() {
  createReportMock.mockResolvedValue({
    report: { id: "rep-1" },
    media: [
      {
        id: "media-1",
        type: "image",
        signedUrl: "https://signed.example/rep-1/0.jpg",
        token: "tok-1",
        path: "rep-1/0.jpg",
      },
    ],
    idempotent: false,
  });
}

beforeEach(() => {
  createReportMock.mockReset();
  getSessionRoleMock.mockReset();
  checkRateLimitMock.mockReset();
  verifyCaptchaMock.mockReset();

  // Defaults: anonymous, under the limit, valid captcha. Each test overrides
  // only what its scenario changes.
  getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  verifyCaptchaMock.mockResolvedValue({ ok: true });
});

describe("POST /api/reports — anti-spam gates (step06)", () => {
  it("rejects an anonymous client over the rate limit with 429 even with a valid captcha (SCEN-001/006)", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false });

    const res = await POST(
      makeRequest(baseline, {
        "cf-turnstile-response": VALID_TOKEN,
        "x-forwarded-for": "203.0.113.5",
      }),
    );

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "rate_limited",
        message: "Has enviado demasiados reportes. Espera unos minutos.",
      },
    });
    // Gate runs before captcha and before the create path.
    expect(verifyCaptchaMock).not.toHaveBeenCalled();
    expect(createReportMock).not.toHaveBeenCalled();
    // Identified by IP for an anonymous caller.
    expect(checkRateLimitMock).toHaveBeenCalledWith("ip:203.0.113.5");
  });

  it("rejects an anonymous client with a missing captcha token with 403 captcha_required (SCEN-002)", async () => {
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "missing" });

    const res = await POST(makeRequest(baseline)); // no cf-turnstile-response

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_required");
    expect(body.error.message).toBe("Completa la verificación de seguridad.");
    expect(verifyCaptchaMock).toHaveBeenCalledOnce();
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("rejects an anonymous client with an invalid captcha token with 403 captcha_invalid (SCEN-003)", async () => {
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "invalid" });

    const res = await POST(
      makeRequest(baseline, { "cf-turnstile-response": "bad.DUMMY.TOKEN" }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_invalid");
    expect(body.error.message).toBe(
      "Verificación de seguridad fallida. Recarga e inténtalo de nuevo.",
    );
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("lets an anonymous client with a valid captcha under the limit succeed with 201 (SCEN-004)", async () => {
    mockCreateSuccess();

    const res = await POST(
      makeRequest(baseline, {
        "cf-turnstile-response": VALID_TOKEN,
        "x-forwarded-for": "203.0.113.5",
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.report_id).toBe("rep-1");
    expect(verifyCaptchaMock).toHaveBeenCalledWith(VALID_TOKEN, "203.0.113.5");
    expect(createReportMock).toHaveBeenCalledOnce();
  });

  it("lets an authenticated citizen under the limit succeed with NO captcha and never calls siteverify (SCEN-005)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-7", role: "citizen" });
    mockCreateSuccess();

    const res = await POST(makeRequest(baseline)); // no cf-turnstile-response

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.report_id).toBe("rep-1");
    // captcha skipped entirely for sessions.
    expect(verifyCaptchaMock).not.toHaveBeenCalled();
    // Rate-limit identified by user id, not IP.
    expect(checkRateLimitMock).toHaveBeenCalledWith("user:u-7");
  });

  it("fails CLOSED on a captcha verification error → 403 (SCEN-007)", async () => {
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "error" });

    const res = await POST(
      makeRequest(baseline, { "cf-turnstile-response": VALID_TOKEN }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_invalid");
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("proceeds when the rate-limit gate fails OPEN (allowed:true) → 201 (SCEN-008)", async () => {
    // checkRateLimit already absorbed its backend error and returned allowed:true.
    getSessionRoleMock.mockResolvedValue({ userId: "u-9", role: "citizen" });
    checkRateLimitMock.mockResolvedValue({ allowed: true });
    mockCreateSuccess();

    const res = await POST(makeRequest(baseline));

    expect(res.status).toBe(201);
    expect(createReportMock).toHaveBeenCalledOnce();
  });

  it("falls back to ip:unknown when no client-ip header is present", async () => {
    mockCreateSuccess();

    await POST(
      makeRequest(baseline, { "cf-turnstile-response": VALID_TOKEN }),
    );

    expect(checkRateLimitMock).toHaveBeenCalledWith("ip:unknown");
  });

  // FIX 2 — the first x-forwarded-for hop is client-controlled; trust the
  // platform-appended trailing hop (or the platform-only headers) instead.
  it("keys on the TRAILING x-forwarded-for hop, ignoring a spoofed first hop (FIX 2)", async () => {
    mockCreateSuccess();

    await POST(
      makeRequest(baseline, {
        "cf-turnstile-response": VALID_TOKEN,
        // Attacker prepends a fake hop; the real proxy hop is appended last.
        "x-forwarded-for": "9.9.9.9, 203.0.113.5",
      }),
    );

    expect(checkRateLimitMock).toHaveBeenCalledWith("ip:203.0.113.5");
  });

  it("a rotated first hop does NOT change the rate-limit identifier (anti-spoof, FIX 2)", async () => {
    mockCreateSuccess();

    await POST(
      makeRequest(baseline, {
        "cf-turnstile-response": VALID_TOKEN,
        "x-forwarded-for": "1.1.1.1, 203.0.113.5",
      }),
    );
    await POST(
      makeRequest(baseline, {
        "cf-turnstile-response": VALID_TOKEN,
        "x-forwarded-for": "2.2.2.2, 203.0.113.5",
      }),
    );

    expect(checkRateLimitMock).toHaveBeenNthCalledWith(1, "ip:203.0.113.5");
    expect(checkRateLimitMock).toHaveBeenNthCalledWith(2, "ip:203.0.113.5");
  });

  it("prefers x-vercel-forwarded-for over x-forwarded-for (FIX 2)", async () => {
    mockCreateSuccess();

    await POST(
      makeRequest(baseline, {
        "cf-turnstile-response": VALID_TOKEN,
        "x-vercel-forwarded-for": "198.51.100.7",
        "x-forwarded-for": "9.9.9.9, 203.0.113.5",
      }),
    );

    expect(checkRateLimitMock).toHaveBeenCalledWith("ip:198.51.100.7");
  });

  it("uses x-real-ip when present and no vercel header (FIX 2)", async () => {
    mockCreateSuccess();

    await POST(
      makeRequest(baseline, {
        "cf-turnstile-response": VALID_TOKEN,
        "x-real-ip": "198.51.100.8",
        "x-forwarded-for": "9.9.9.9, 203.0.113.5",
      }),
    );

    expect(checkRateLimitMock).toHaveBeenCalledWith("ip:198.51.100.8");
  });

  // FIX 3 — getSessionRole() may throw before any gate (e.g. supabase client
  // construction). It must degrade to anonymous (captcha-walled), not 500.
  it("treats a getSessionRole() throw as anonymous — no header → 403, not 500 (FIX 3)", async () => {
    getSessionRoleMock.mockRejectedValue(new Error("supabase client boom"));
    // Degraded-to-anonymous path hits the captcha gate; with no token the gate
    // returns missing.
    verifyCaptchaMock.mockResolvedValue({ ok: false, reason: "missing" });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await POST(makeRequest(baseline)); // no cf-turnstile-response

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("captcha_required");
    expect(createReportMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("POST /api/reports — create path (step05)", () => {
  it("returns 201 with the mapped media upload shape on success", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    createReportMock.mockResolvedValue({
      report: { id: "rep-1" },
      media: [
        {
          id: "media-1",
          type: "image",
          signedUrl: "https://signed.example/rep-1/0.jpg",
          token: "tok-1",
          path: "rep-1/0.jpg",
        },
      ],
      idempotent: false,
    });

    const res = await POST(makeRequest(baseline, { "Idempotency-Key": "k-001" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      report_id: "rep-1",
      media: [
        {
          id: "media-1",
          type: "image",
          upload: {
            signedUrl: "https://signed.example/rep-1/0.jpg",
            token: "tok-1",
            path: "rep-1/0.jpg",
          },
        },
      ],
    });
    // idempotency key forwarded to the service
    expect(createReportMock).toHaveBeenCalledWith(expect.anything(), "k-001");
  });

  it("returns 200 with the same report_id on idempotent replay", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    createReportMock.mockResolvedValue({
      report: { id: "rep-1" },
      media: [
        {
          id: "media-1",
          type: "image",
          signedUrl: "https://signed.example/rep-1/0.jpg",
          token: "tok-1",
          path: "rep-1/0.jpg",
        },
      ],
      idempotent: true,
    });

    const res = await POST(makeRequest(baseline, { "Idempotency-Key": "k-002" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report_id).toBe("rep-1");
  });

  it("returns 422 with the validation error shape for an oversize image", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    const res = await POST(
      makeRequest(
        { ...baseline, media: [{ type: "image", mime: "image/jpeg", size: 12000000 }] },
        { "Idempotency-Key": "k-003" },
      ),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "media_too_large",
        message: "La imagen supera el tamaño máximo de 10 MB.",
        field: "media.0.size",
      },
    });
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("returns 422 category_invalid when the service rejects the category", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    createReportMock.mockRejectedValue(new CategoryInvalidError("inexistente"));

    const res = await POST(
      makeRequest({ ...baseline, category: "inexistente" }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "category_invalid",
        message: "Categoría no válida.",
        field: "category",
      },
    });
  });

  it("treats a blank Idempotency-Key header as no key", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    let call = 0;
    createReportMock.mockImplementation(async () => {
      call += 1;
      return {
        report: { id: `rep-${call}` },
        media: [
          {
            id: `media-${call}`,
            type: "image",
            signedUrl: `https://signed.example/rep-${call}/0.jpg`,
            token: `tok-${call}`,
            path: `rep-${call}/0.jpg`,
          },
        ],
        idempotent: false,
      };
    });

    const res1 = await POST(makeRequest(baseline, { "Idempotency-Key": "" }));
    const res2 = await POST(makeRequest(baseline, { "Idempotency-Key": "   " }));

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.report_id).not.toBe(body2.report_id);

    expect(createReportMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      undefined,
    );
    expect(createReportMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      undefined,
    );
  });

  it("rejects an over-long Idempotency-Key with 422 (defensive)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    const res = await POST(
      makeRequest(baseline, { "Idempotency-Key": "x".repeat(201) }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("idempotency_key_invalid");
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("returns 422 invalid_json for an unparseable body", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    const res = await POST(makeRequest("{not json", {}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 500 internal_error for an unexpected service failure", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    createReportMock.mockRejectedValue(new Error("db is on fire"));

    const res = await POST(makeRequest(baseline));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
  });
});
