import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/reports/[id]/status (step13).
// getSessionRole + changeReportStatus are mocked so the route's ORDER and
// branch logic is the unit under test:
//   SCEN-001 citizen -> 403, service NOT called
//   SCEN-002 anonymous (role null) -> 403, service NOT called
//   SCEN-005 invalid status -> 400, service NOT called
//   malformed id -> 400 (service not called)
//   SCEN-006 unknown report -> 404 (service throws ReportNotFoundError)
//   staff valid -> 200 echoing the service row
// No anti-spam gates run here.

const getSessionRoleMock = vi.fn();
const changeReportStatusMock = vi.fn();

vi.mock("@/lib/services/authz", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/services/authz")>(
      "@/lib/services/authz",
    );
  return {
    ...actual,
    getSessionRole: (...args: unknown[]) => getSessionRoleMock(...args),
  };
});

vi.mock("@/lib/services/statusService", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/services/statusService")>(
      "@/lib/services/statusService",
    );
  return {
    ...actual,
    changeReportStatus: (...args: unknown[]) => changeReportStatusMock(...args),
  };
});

import { ReportNotFoundError } from "@/lib/services/statusService";
import { POST } from "./route";

const VALID_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeRequest(id: string, body: unknown) {
  return {
    request: new Request(`http://localhost/api/reports/${id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  getSessionRoleMock.mockReset();
  changeReportStatusMock.mockReset();
  // Default: a staff session under test unless a case overrides it.
  getSessionRoleMock.mockResolvedValue({ userId: "s-1", role: "staff" });
});

describe("POST /api/reports/[id]/status", () => {
  it("returns 403 for an authenticated citizen and never calls the service (SCEN-001)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    const { request, ctx } = makeRequest(VALID_ID, { status: "en_proceso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
    expect(changeReportStatusMock).not.toHaveBeenCalled();
  });

  it("returns 403 for an anonymous caller (role null) and never calls the service (SCEN-002)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
    const { request, ctx } = makeRequest(VALID_ID, { status: "en_proceso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(changeReportStatusMock).not.toHaveBeenCalled();
  });

  it("treats a getSessionRole throw as anonymous -> 403 (fail closed)", async () => {
    getSessionRoleMock.mockRejectedValue(new Error("supabase boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID, { status: "en_proceso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(changeReportStatusMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns 400 for a malformed id without calling the service", async () => {
    const { request, ctx } = makeRequest("not-a-uuid", { status: "en_proceso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("id_invalid");
    expect(changeReportStatusMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid target status and never calls the service (SCEN-005)", async () => {
    const { request, ctx } = makeRequest(VALID_ID, { status: "archivado" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("status_invalid");
    expect(changeReportStatusMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unparseable body", async () => {
    const { request, ctx } = makeRequest(VALID_ID, "{not json");

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
    expect(changeReportStatusMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the service reports an unknown report (SCEN-006)", async () => {
    changeReportStatusMock.mockRejectedValue(new ReportNotFoundError(VALID_ID));
    const { request, ctx } = makeRequest(VALID_ID, { status: "en_proceso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns 200 echoing the service row on a valid staff change (SCEN-003/004)", async () => {
    changeReportStatusMock.mockResolvedValue({
      id: VALID_ID,
      status: "resuelto",
      resolved_at: "2026-06-05T12:00:00Z",
    });
    const { request, ctx } = makeRequest(VALID_ID, {
      status: "resuelto",
      note: "listo",
    });

    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: VALID_ID,
      status: "resuelto",
      resolved_at: "2026-06-05T12:00:00Z",
    });
    // The trimmed note and validated status reached the service.
    expect(changeReportStatusMock).toHaveBeenCalledWith(
      VALID_ID,
      "resuelto",
      "listo",
    );
  });

  it("passes note=null to the service when the body omits the note", async () => {
    changeReportStatusMock.mockResolvedValue({
      id: VALID_ID,
      status: "en_proceso",
      resolved_at: null,
    });
    const { request, ctx } = makeRequest(VALID_ID, { status: "en_proceso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    expect(changeReportStatusMock).toHaveBeenCalledWith(
      VALID_ID,
      "en_proceso",
      null,
    );
  });

  it("returns 500 for an unexpected service failure", async () => {
    changeReportStatusMock.mockRejectedValue(new Error("db is on fire"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID, { status: "en_proceso" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    errorSpy.mockRestore();
  });
});
