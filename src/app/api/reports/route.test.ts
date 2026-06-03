import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/reports (step05) with a MOCKED service.
// Validation runs for real (so SCEN-003 oversize maps to a 422 error shape);
// createReport is mocked to assert status codes and response body mapping for
// the happy path, idempotent replay, and CategoryInvalidError.

const createReportMock = vi.fn();

vi.mock("@/lib/services/reportService", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/reportService")
  >("@/lib/services/reportService");
  return {
    ...actual,
    createReport: (...args: unknown[]) => createReportMock(...args),
  };
});

import { CategoryInvalidError } from "@/lib/services/reportService";
import { POST } from "./route";

const baseline = {
  category: "bache",
  lat: 4.6097,
  lng: -74.0817,
  description: "Bache profundo frente al colegio, peligroso para motos.",
  media: [{ type: "image", mime: "image/jpeg", size: 2000000 }],
};

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  createReportMock.mockReset();
});

describe("POST /api/reports", () => {
  it("returns 201 with the mapped media upload shape on success (SCEN-001)", async () => {
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

  it("returns 200 with the same report_id on idempotent replay (SCEN-002)", async () => {
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

  it("returns 422 with the validation error shape for an oversize image (SCEN-003)", async () => {
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

  it("returns 422 category_invalid when the service rejects the category (SCEN-007)", async () => {
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

  it("treats a blank Idempotency-Key header as no key (SCEN-010)", async () => {
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

    // Two POSTs, each with a blank (and whitespace-only) Idempotency-Key.
    const res1 = await POST(makeRequest(baseline, { "Idempotency-Key": "" }));
    const res2 = await POST(makeRequest(baseline, { "Idempotency-Key": "   " }));

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    const body1 = await res1.json();
    const body2 = await res2.json();
    // Distinct reports — no cross-request collision.
    expect(body1.report_id).not.toBe(body2.report_id);

    // The service was handed `undefined`, never an empty string.
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
    const res = await POST(
      makeRequest(baseline, { "Idempotency-Key": "x".repeat(201) }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("idempotency_key_invalid");
    expect(createReportMock).not.toHaveBeenCalled();
  });

  it("returns 422 invalid_json for an unparseable body", async () => {
    const res = await POST(makeRequest("{not json", {}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
  });

  it("returns 500 internal_error for an unexpected service failure", async () => {
    createReportMock.mockRejectedValue(new Error("db is on fire"));

    const res = await POST(makeRequest(baseline));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
  });
});
