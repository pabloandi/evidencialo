import { describe, expect, it } from "vitest";

import {
  InvalidInputError,
  ReportNotValidatableError,
  validateReport,
} from "./validationService";

// Observable contract for the validation service (A2) with a MOCKED client.
//
// validateReport calls the `validate_report` RPC and normalizes the Postgres
// error CODE into a typed error the route maps to an HTTP status:
//   P0001 -> ReportNotValidatableError (409), 22023 -> InvalidInputError (400).
// On success it maps the snake_case RPC row to the camelCase result and forwards
// `{ p_report_id, p_ip_hash }`.

const REPORT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const IP_HASH = "deadbeefdeadbeefdeadbeefdeadbeef";

type SbResult =
  | { data: unknown; error: null }
  | { data: null; error: { code?: string; message?: string } };

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
  return client as unknown as Parameters<typeof validateReport>[2] & {
    __calls: Array<{ fn: string; args: unknown }>;
  };
}

describe("validateReport", () => {
  it("returns the mapped counts on success and forwards the RPC params (anonymous)", async () => {
    const client = makeRpcClient({
      data: [{ verified_count: 2, anon_count: 5, newly_added: true }],
      error: null,
    });

    const res = await validateReport(REPORT_ID, IP_HASH, client);

    expect(res).toEqual({
      verifiedCount: 2,
      anonCount: 5,
      newlyAdded: true,
    });
    expect(client.__calls[0].fn).toBe("validate_report");
    expect(client.__calls[0].args).toEqual({
      p_report_id: REPORT_ID,
      p_ip_hash: IP_HASH,
    });
  });

  it("forwards a null ip_hash (authenticated caller)", async () => {
    const client = makeRpcClient({
      data: [{ verified_count: 1, anon_count: 0, newly_added: false }],
      error: null,
    });

    const res = await validateReport(REPORT_ID, null, client);

    expect(res).toEqual({
      verifiedCount: 1,
      anonCount: 0,
      newlyAdded: false,
    });
    expect(client.__calls[0].args).toEqual({
      p_report_id: REPORT_ID,
      p_ip_hash: null,
    });
  });

  it("maps a P0001 error to ReportNotValidatableError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "P0001", message: "report not validatable" },
    });

    await expect(
      validateReport(REPORT_ID, null, client),
    ).rejects.toBeInstanceOf(ReportNotValidatableError);
  });

  it("maps a 22023 error to InvalidInputError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "22023", message: "ip_hash required" },
    });

    await expect(
      validateReport(REPORT_ID, null, client),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("throws a generic Error for an unexpected RPC failure", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "XX000", message: "db is on fire" },
    });

    await expect(
      validateReport(REPORT_ID, null, client),
    ).rejects.toThrow(/validateReport failed/);
  });

  it("treats an empty result with no error as a generic failure (defensive)", async () => {
    const client = makeRpcClient({ data: [], error: null });

    await expect(
      validateReport(REPORT_ID, null, client),
    ).rejects.toThrow(/validateReport failed/);
  });
});
