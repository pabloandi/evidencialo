import { describe, expect, it, vi } from "vitest";

// fileDispute generates the dispute id app-side (it inserts with return=minimal
// and never reads the row back — the SELECT policy is admin-only). Pin
// `randomUUID` so the generated id is deterministic and assertions stay exact.
const { MOCK_DISPUTE_ID } = vi.hoisted(() => ({
  MOCK_DISPUTE_ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: () => MOCK_DISPUTE_ID };
});

import {
  DisputeAlreadyResolvedError,
  DisputeExistsError,
  DisputeNotFoundError,
  ForbiddenError,
  ReportNotDisputableError,
  fileDispute,
  resolveDispute,
} from "./disputeService";

// Observable contract for the dispute service (B3.2) with a MOCKED client.
//
// fileDispute inserts into `report_disputes` and normalizes the Postgres error
// CODE into a typed error the route maps to an HTTP status:
//   23505 -> DisputeExistsError (409), 42501 -> ReportNotDisputableError (409).
// resolveDispute calls the `resolve_dispute` RPC:
//   42501 -> ForbiddenError (403), P0002 -> DisputeNotFoundError (404),
//   P0001 -> DisputeAlreadyResolvedError (409).

const REPORT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DISPUTE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

type SbResult =
  | { data: unknown; error: null }
  | { data: null; error: { code?: string; message?: string } };

/**
 * Build a fake client whose `.from().insert()` records the inserted row and
 * resolves `behavior` directly (a thenable). The chain intentionally has NO
 * `.select()`: `report_disputes` has an admin-only SELECT policy, so the filer
 * inserts with `return=minimal` and the id is generated app-side. If production
 * code re-introduces `.select()`, `insert()` here returns a plain Promise with
 * no `.select` method and the call throws — a guard against that regression.
 */
function makeInsertClient(behavior: SbResult) {
  const calls: Array<{ table: string; row: unknown }> = [];
  const client = {
    from(table: string) {
      return {
        insert(row: unknown) {
          calls.push({ table, row });
          return Promise.resolve(behavior);
        },
      };
    },
    __calls: calls,
  };
  return client as unknown as Parameters<typeof fileDispute>[3] & {
    __calls: Array<{ table: string; row: unknown }>;
  };
}

/** Build a fake client whose `.rpc()` records its args and resolves `behavior`. */
function makeRpcClient(behavior: SbResult) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const client = {
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return Promise.resolve(behavior);
    },
    __calls: calls,
  };
  return client as unknown as Parameters<typeof resolveDispute>[2] & {
    __calls: Array<{ fn: string; args: unknown }>;
  };
}

describe("fileDispute", () => {
  it("inserts the dispute row (return=minimal) and returns the app-generated id", async () => {
    const client = makeInsertClient({ data: null, error: null });

    const res = await fileDispute(REPORT_ID, "es falso", USER_ID, client);

    // id is generated app-side (the row is never read back) — randomUUID is mocked.
    expect(res).toEqual({ id: DISPUTE_ID });
    expect(client.__calls[0].table).toBe("report_disputes");
    expect(client.__calls[0].row).toEqual({
      id: DISPUTE_ID,
      report_id: REPORT_ID,
      reason: "es falso",
      created_by: USER_ID,
      status: "open",
    });
  });

  it("forwards a null reason and null userId (anonymous, no motive)", async () => {
    const client = makeInsertClient({ data: null, error: null });

    const res = await fileDispute(REPORT_ID, null, null, client);

    expect(res).toEqual({ id: DISPUTE_ID });
    expect(client.__calls[0].row).toEqual({
      id: DISPUTE_ID,
      report_id: REPORT_ID,
      reason: null,
      created_by: null,
      status: "open",
    });
  });

  it("maps a 23505 unique violation to DisputeExistsError", async () => {
    const client = makeInsertClient({
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });

    await expect(
      fileDispute(REPORT_ID, null, USER_ID, client),
    ).rejects.toBeInstanceOf(DisputeExistsError);
  });

  it("maps a 42501 RLS rejection to ReportNotDisputableError", async () => {
    const client = makeInsertClient({
      data: null,
      error: { code: "42501", message: "row violates row-level security" },
    });

    await expect(
      fileDispute(REPORT_ID, null, USER_ID, client),
    ).rejects.toBeInstanceOf(ReportNotDisputableError);
  });

  it("throws a generic Error for an unexpected insert failure", async () => {
    const client = makeInsertClient({
      data: null,
      error: { code: "XX000", message: "db is on fire" },
    });

    await expect(
      fileDispute(REPORT_ID, null, USER_ID, client),
    ).rejects.toThrow(/fileDispute failed/);
  });
});

describe("resolveDispute", () => {
  it("returns the echoed row on success and forwards the RPC params (uphold)", async () => {
    const client = makeRpcClient({
      data: [
        {
          dispute_id: DISPUTE_ID,
          dispute_status: "upheld",
          report_status: "resuelto",
        },
      ],
      error: null,
    });

    const res = await resolveDispute(DISPUTE_ID, "uphold", client);

    expect(res).toEqual({
      dispute_id: DISPUTE_ID,
      dispute_status: "upheld",
      report_status: "resuelto",
    });
    expect(client.__calls[0].fn).toBe("resolve_dispute");
    expect(client.__calls[0].args).toEqual({
      p_dispute_id: DISPUTE_ID,
      p_action: "uphold",
    });
  });

  it("returns the reverted row on a revert action", async () => {
    const client = makeRpcClient({
      data: [
        {
          dispute_id: DISPUTE_ID,
          dispute_status: "reverted",
          report_status: "en_proceso",
        },
      ],
      error: null,
    });

    const res = await resolveDispute(DISPUTE_ID, "revert", client);

    expect(res.dispute_status).toBe("reverted");
    expect(res.report_status).toBe("en_proceso");
    expect(client.__calls[0].args).toEqual({
      p_dispute_id: DISPUTE_ID,
      p_action: "revert",
    });
  });

  it("maps a 42501 error to ForbiddenError (non-admin)", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });

    await expect(
      resolveDispute(DISPUTE_ID, "uphold", client),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps a P0002 error to DisputeNotFoundError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "P0002", message: "dispute not found" },
    });

    await expect(
      resolveDispute(DISPUTE_ID, "uphold", client),
    ).rejects.toBeInstanceOf(DisputeNotFoundError);
  });

  it("maps a P0001 error to DisputeAlreadyResolvedError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "P0001", message: "dispute already resolved" },
    });

    await expect(
      resolveDispute(DISPUTE_ID, "uphold", client),
    ).rejects.toBeInstanceOf(DisputeAlreadyResolvedError);
  });

  it("throws a generic Error for an unexpected RPC failure", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "XX000", message: "db is on fire" },
    });

    await expect(
      resolveDispute(DISPUTE_ID, "uphold", client),
    ).rejects.toThrow(/resolve_dispute failed/);
  });

  it("treats an empty result with no error as not found (defensive)", async () => {
    const client = makeRpcClient({ data: [], error: null });

    await expect(
      resolveDispute(DISPUTE_ID, "uphold", client),
    ).rejects.toBeInstanceOf(DisputeNotFoundError);
  });
});
