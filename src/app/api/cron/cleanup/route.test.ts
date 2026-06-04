import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for GET /api/cron/cleanup (step10). cleanupOrphans is
// mocked so the unit under test is the route's CRON_SECRET auth gate + the
// success/error mapping.
//
// SCEN-005: no Authorization header -> 401 and the service is NOT invoked; a
//   wrong secret -> 401 and not invoked. A correct `Bearer <secret>` -> 200 and
//   the service is invoked exactly once.

const cleanupOrphansMock = vi.fn();

vi.mock("@/lib/services/cleanupService", () => ({
  cleanupOrphans: (...args: unknown[]) => cleanupOrphansMock(...args),
}));

import { GET } from "./route";

const SECRET = "test-cron-secret";

function makeRequest(authHeader?: string) {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers.authorization = authHeader;
  return new Request("http://localhost/api/cron/cleanup", {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  cleanupOrphansMock.mockReset();
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe("GET /api/cron/cleanup", () => {
  it("returns 401 and does NOT invoke cleanup when no Authorization header is present (SCEN-005)", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(cleanupOrphansMock).not.toHaveBeenCalled();
  });

  it("returns 401 and does NOT invoke cleanup when the secret is wrong (SCEN-005)", async () => {
    const res = await GET(makeRequest("Bearer wrong-secret"));

    expect(res.status).toBe(401);
    expect(cleanupOrphansMock).not.toHaveBeenCalled();
  });

  it("returns 401 when CRON_SECRET env is unset (fail closed)", async () => {
    delete process.env.CRON_SECRET;

    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(401);
    expect(cleanupOrphansMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the deleted + residue counts and invokes cleanup once on a correct Bearer secret (SCEN-005 + FIX C)", async () => {
    cleanupOrphansMock.mockResolvedValue({
      deletedReportIds: ["a", "b", "c"],
      storageResidueReportIds: ["b"],
    });

    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    // Monitoring can alert when storageResidue > 0 (orphan row gone, objects left).
    expect(body).toEqual({ deleted: 3, storageResidue: 1 });
    expect(cleanupOrphansMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the cleanup service throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanupOrphansMock.mockRejectedValue(new Error("storage is on fire"));

    const res = await GET(makeRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
