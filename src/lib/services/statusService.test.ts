import { describe, expect, it } from "vitest";

import {
  ForbiddenError,
  ReportNotFoundError,
  changeReportStatus,
} from "./statusService";

// Observable contract for changeReportStatus (step13) with a MOCKED client.
// The service calls the `change_report_status` RPC and normalizes the Postgres
// error CODE into a typed error the route maps to an HTTP status:
//   42501 -> ForbiddenError (403), P0002 -> ReportNotFoundError (404).
// The happy path returns the single echoed row.

const REPORT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

type RpcBehavior =
  | { data: unknown; error: null }
  | { data: null; error: { code?: string; message?: string } };

/** Build a fake client whose `.rpc()` records its args and returns `behavior`. */
function makeFakeClient(behavior: RpcBehavior) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const client = {
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return Promise.resolve(behavior);
    },
    __calls: calls,
  };
  return client as unknown as Parameters<typeof changeReportStatus>[3] & {
    __calls: Array<{ fn: string; args: unknown }>;
  };
}

describe("changeReportStatus", () => {
  it("returns the echoed row on success and forwards the RPC params", async () => {
    const client = makeFakeClient({
      data: [
        { id: REPORT_ID, status: "resuelto", resolved_at: "2026-06-05T12:00:00Z" },
      ],
      error: null,
    });

    const res = await changeReportStatus(REPORT_ID, "resuelto", "listo", client);

    expect(res).toEqual({
      id: REPORT_ID,
      status: "resuelto",
      resolved_at: "2026-06-05T12:00:00Z",
    });
    expect(client.__calls[0].fn).toBe("change_report_status");
    expect(client.__calls[0].args).toEqual({
      p_report_id: REPORT_ID,
      p_to_status: "resuelto",
      p_note: "listo",
    });
  });

  it("maps a 42501 error to ForbiddenError (SCEN-007)", async () => {
    const client = makeFakeClient({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });

    await expect(
      changeReportStatus(REPORT_ID, "en_proceso", null, client),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps a P0002 error to ReportNotFoundError (SCEN-006)", async () => {
    const client = makeFakeClient({
      data: null,
      error: { code: "P0002", message: "report not found" },
    });

    await expect(
      changeReportStatus(REPORT_ID, "en_proceso", null, client),
    ).rejects.toBeInstanceOf(ReportNotFoundError);
  });

  it("throws a generic Error for an unexpected RPC failure", async () => {
    const client = makeFakeClient({
      data: null,
      error: { code: "XX000", message: "db is on fire" },
    });

    await expect(
      changeReportStatus(REPORT_ID, "en_proceso", null, client),
    ).rejects.toThrow(/change_report_status failed/);
  });

  it("treats an empty result with no error as not found (defensive)", async () => {
    const client = makeFakeClient({ data: [], error: null });

    await expect(
      changeReportStatus(REPORT_ID, "en_proceso", null, client),
    ).rejects.toBeInstanceOf(ReportNotFoundError);
  });
});
