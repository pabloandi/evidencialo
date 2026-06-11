import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/disputes/[id]/resolve (B3.2).
// getSessionRole + resolveDispute are mocked so the route's ORDER and branch
// logic is the unit under test (NO anti-spam gates here):
//   malformed id -> 400
//   non-admin (citizen/staff/anonymous) -> 403, service NOT called
//   invalid action -> 400, service NOT called
//   success -> 200 { dispute_status, report_status }
//   ForbiddenError -> 403, DisputeNotFoundError -> 404,
//   DisputeAlreadyResolvedError -> 409, unexpected -> 500

const getSessionRoleMock = vi.fn();
const resolveDisputeMock = vi.fn();

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

vi.mock("@/lib/services/disputeService", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/services/disputeService")>(
      "@/lib/services/disputeService",
    );
  return {
    ...actual,
    resolveDispute: (...args: unknown[]) => resolveDisputeMock(...args),
  };
});

import {
  DisputeAlreadyResolvedError,
  DisputeNotFoundError,
  ForbiddenError,
} from "@/lib/services/disputeService";
import { POST } from "./route";

const VALID_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeRequest(id: string, body: unknown) {
  return {
    request: new Request(`http://localhost/api/disputes/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  getSessionRoleMock.mockReset();
  resolveDisputeMock.mockReset();
  // Default: an admin session unless a case overrides it.
  getSessionRoleMock.mockResolvedValue({ userId: "a-1", role: "admin" });
});

describe("POST /api/disputes/[id]/resolve", () => {
  it("returns 400 for a malformed id without calling the service", async () => {
    const { request, ctx } = makeRequest("not-a-uuid", { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("id_invalid");
    expect(resolveDisputeMock).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated citizen and never calls the service", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
    expect(resolveDisputeMock).not.toHaveBeenCalled();
  });

  it("returns 403 for staff (admin-only review) and never calls the service", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "s-1", role: "staff" });
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(resolveDisputeMock).not.toHaveBeenCalled();
  });

  it("returns 403 for an anonymous caller (role null)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(resolveDisputeMock).not.toHaveBeenCalled();
  });

  it("treats a getSessionRole throw as anonymous -> 403 (fail closed)", async () => {
    getSessionRoleMock.mockRejectedValue(new Error("supabase boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(resolveDisputeMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns 400 for an invalid action and never calls the service", async () => {
    const { request, ctx } = makeRequest(VALID_ID, { action: "delete" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("action_invalid");
    expect(resolveDisputeMock).not.toHaveBeenCalled();
  });

  it("returns 400 for an unparseable body", async () => {
    const { request, ctx } = makeRequest(VALID_ID, "{not json");

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
    expect(resolveDisputeMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the echoed statuses on an uphold", async () => {
    resolveDisputeMock.mockResolvedValue({
      dispute_id: VALID_ID,
      dispute_status: "upheld",
      report_status: "resuelto",
    });
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      dispute_status: "upheld",
      report_status: "resuelto",
    });
    expect(resolveDisputeMock).toHaveBeenCalledWith(VALID_ID, "uphold");
  });

  it("returns 200 with en_proceso on a revert", async () => {
    resolveDisputeMock.mockResolvedValue({
      dispute_id: VALID_ID,
      dispute_status: "reverted",
      report_status: "en_proceso",
    });
    const { request, ctx } = makeRequest(VALID_ID, { action: "revert" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report_status).toBe("en_proceso");
    expect(resolveDisputeMock).toHaveBeenCalledWith(VALID_ID, "revert");
  });

  it("returns 403 when the service raises ForbiddenError (DB-layer re-check)", async () => {
    resolveDisputeMock.mockRejectedValue(new ForbiddenError());
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
  });

  it("returns 404 not_found when the dispute does not exist", async () => {
    resolveDisputeMock.mockRejectedValue(new DisputeNotFoundError(VALID_ID));
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns 409 already_resolved when the dispute was already reviewed", async () => {
    resolveDisputeMock.mockRejectedValue(new DisputeAlreadyResolvedError());
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("already_resolved");
  });

  it("returns 500 internal_error for an unexpected service failure", async () => {
    resolveDisputeMock.mockRejectedValue(new Error("db is on fire"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID, { action: "uphold" });

    const res = await POST(request, ctx);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
