import { describe, expect, it } from "vitest";

import {
  ForbiddenError,
  InvalidChannelError,
  deleteDonationChannel,
  setDonationChannel,
} from "./donationService";

// Observable contract for the donation service (D2) with a MOCKED client. The
// service wraps the two DEFINER RPCs and normalizes the Postgres error CODE into
// a typed error the route maps to an HTTP status:
//   42501 -> ForbiddenError (403), 23514/22023 -> InvalidChannelError (422).
// solver_id is NEVER forwarded — the RPC derives it from auth.uid().

const SOLVER_ID = "11111111-1111-1111-1111-111111111111";

type SbResult =
  | { data: unknown; error: null }
  | { data: null; error: { code?: string; message?: string } };

/** Fake client whose `.rpc()` records its args and resolves `behavior`. */
function makeRpcClient(behavior: SbResult) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(behavior);
    },
    __calls: calls,
  };
  // The service only ever calls `.rpc()`.
  return client as unknown as Parameters<typeof setDonationChannel>[0] & {
    __calls: Array<{ fn: string; args: Record<string, unknown> }>;
  };
}

const ROW = {
  id: "22222222-2222-2222-2222-222222222222",
  solver_id: SOLVER_ID,
  type: "nequi",
  value: "3001234567",
  account_kind: null,
  qr_path: null,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z",
};

describe("setDonationChannel", () => {
  it("forwards the RPC params (no solver_id) and returns the echoed row", async () => {
    const client = makeRpcClient({ data: ROW, error: null });

    const res = await setDonationChannel(
      client,
      {
        type: "nequi",
        value: "3001234567",
        accountKind: null,
        qrPath: "donation-qr/x/nequi.png",
      },
      { ip: "1.2.3.4", ua: "vitest" },
    );

    expect(res).toEqual(ROW);
    expect(client.__calls[0].fn).toBe("set_solver_donation_channel");
    expect(client.__calls[0].args).toEqual({
      p_type: "nequi",
      p_value: "3001234567",
      p_account_kind: null,
      p_qr_path: "donation-qr/x/nequi.png",
      p_request_meta: { ip: "1.2.3.4", ua: "vitest" },
    });
    // The boundary invariant: no solver id is ever forwarded to the RPC.
    expect(client.__calls[0].args).not.toHaveProperty("p_solver_id");
    expect(client.__calls[0].args).not.toHaveProperty("solver_id");
  });

  it("unwraps a single-row array result", async () => {
    const client = makeRpcClient({ data: [ROW], error: null });
    const res = await setDonationChannel(
      client,
      { type: "nequi", value: "3001234567", accountKind: null, qrPath: null },
      {},
    );
    expect(res).toEqual(ROW);
  });

  it("forwards a bancolombia account_kind", async () => {
    const client = makeRpcClient({ data: ROW, error: null });
    await setDonationChannel(
      client,
      {
        type: "bancolombia",
        value: "1234567890",
        accountKind: "ahorros",
        qrPath: null,
      },
      {},
    );
    expect(client.__calls[0].args.p_account_kind).toBe("ahorros");
  });

  it("maps 42501 to ForbiddenError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });
    await expect(
      setDonationChannel(
        client,
        { type: "nequi", value: "3001234567", accountKind: null, qrPath: null },
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps 23514 (CHECK) to InvalidChannelError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "23514", message: "check constraint" },
    });
    await expect(
      setDonationChannel(
        client,
        { type: "nequi", value: "3001234567", accountKind: null, qrPath: null },
        {},
      ),
    ).rejects.toBeInstanceOf(InvalidChannelError);
  });

  it("maps 22023 (request_meta too large) to InvalidChannelError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "22023", message: "request_meta too large" },
    });
    await expect(
      setDonationChannel(
        client,
        { type: "nequi", value: "3001234567", accountKind: null, qrPath: null },
        {},
      ),
    ).rejects.toBeInstanceOf(InvalidChannelError);
  });

  it("throws a generic Error for an unexpected failure", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "XX000", message: "db on fire" },
    });
    await expect(
      setDonationChannel(
        client,
        { type: "nequi", value: "3001234567", accountKind: null, qrPath: null },
        {},
      ),
    ).rejects.toThrow(/donation channel RPC failed/);
  });

  it("throws when a success result carries no row (defensive)", async () => {
    const client = makeRpcClient({ data: null, error: null });
    await expect(
      setDonationChannel(
        client,
        { type: "nequi", value: "3001234567", accountKind: null, qrPath: null },
        {},
      ),
    ).rejects.toThrow(/returned no row/);
  });
});

describe("deleteDonationChannel", () => {
  it("forwards the type + request_meta (no solver_id) and resolves on success", async () => {
    const client = makeRpcClient({ data: null, error: null });

    await deleteDonationChannel(client, "nequi", { ip: "1.2.3.4", ua: "vitest" });

    expect(client.__calls[0].fn).toBe("delete_solver_donation_channel");
    expect(client.__calls[0].args).toEqual({
      p_type: "nequi",
      p_request_meta: { ip: "1.2.3.4", ua: "vitest" },
    });
    expect(client.__calls[0].args).not.toHaveProperty("p_solver_id");
  });

  it("maps 42501 to ForbiddenError", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "42501", message: "forbidden" },
    });
    await expect(
      deleteDonationChannel(client, "nequi", {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws a generic Error for an unexpected failure", async () => {
    const client = makeRpcClient({
      data: null,
      error: { code: "XX000", message: "db on fire" },
    });
    await expect(
      deleteDonationChannel(client, "nequi", {}),
    ).rejects.toThrow(/donation channel RPC failed/);
  });
});
