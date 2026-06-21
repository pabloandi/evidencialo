import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST/DELETE /api/solver/donation-channels (D2). The
// owner gate + the service are mocked so the route's branch logic is the unit
// under test. Per plan D2.3 acceptance:
//   (a) anon -> 401, non-solver -> 403, owner succeeds;
//   (b) SCEN-002: a body carrying a stray solver_id/solverId is IGNORED — the
//       route forwards no client solver id to the service;
//   (c) SCEN-006 wired: a non-paypal.me PayPal value -> 422 (schema on the path);
//   (d) ForbiddenError -> 403, InvalidChannelError -> 422.

const getSessionRoleMock = vi.fn();
const setDonationChannelMock = vi.fn();
const deleteDonationChannelMock = vi.fn();
const createServerSupabaseMock = vi.fn();

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

vi.mock("@/lib/services/donationService", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/donationService")
  >("@/lib/services/donationService");
  return {
    ...actual,
    setDonationChannel: (...args: unknown[]) => setDonationChannelMock(...args),
    deleteDonationChannel: (...args: unknown[]) =>
      deleteDonationChannelMock(...args),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: (...args: unknown[]) => createServerSupabaseMock(...args),
}));

import {
  ForbiddenError,
  InvalidChannelError,
} from "@/lib/services/donationService";
import { DELETE, POST } from "./route";

const FAKE_CLIENT = { __kind: "authenticated-server-client" };

const CHANNEL_ROW = {
  id: "22222222-2222-2222-2222-222222222222",
  solver_id: "s-1",
  type: "nequi",
  value: "3001234567",
  account_kind: null,
  qr_path: null,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z",
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/solver/donation-channels", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function del(body: unknown) {
  return new Request("http://localhost/api/solver/donation-channels", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getSessionRoleMock.mockReset();
  setDonationChannelMock.mockReset();
  deleteDonationChannelMock.mockReset();
  createServerSupabaseMock.mockReset();
  // Default: a verified solver session unless a case overrides it.
  getSessionRoleMock.mockResolvedValue({ userId: "s-1", role: "solver" });
  createServerSupabaseMock.mockResolvedValue(FAKE_CLIENT);
  setDonationChannelMock.mockResolvedValue(CHANNEL_ROW);
  deleteDonationChannelMock.mockResolvedValue(undefined);
});

describe("POST — owner gate", () => {
  it("returns 401 for an anonymous caller without calling the service", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
    const res = await POST(post({ type: "nequi", value: "3001234567" }));
    expect(res.status).toBe(401);
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });

  it("returns 403 for an authenticated non-solver (citizen)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "c-1", role: "citizen" });
    const res = await POST(post({ type: "nequi", value: "3001234567" }));
    expect(res.status).toBe(403);
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });
});

describe("POST — success + boundary", () => {
  it("(a) owner succeeds: validates, calls the service with the AUTH client, 200", async () => {
    const res = await POST(post({ type: "nequi", value: "300 123 4567" }));
    expect(res.status).toBe(200);

    expect(setDonationChannelMock).toHaveBeenCalledTimes(1);
    const [client, input, meta] = setDonationChannelMock.mock.calls[0];
    // The AUTHENTICATED server client is used (so auth.uid() resolves), NOT admin.
    expect(client).toBe(FAKE_CLIENT);
    // The value is normalized (separators stripped) by the schema.
    expect(input).toEqual({
      type: "nequi",
      value: "3001234567",
      accountKind: null,
      qrPath: null,
    });
    expect(meta).toHaveProperty("ip");
    expect(meta).toHaveProperty("ua");
  });

  it("(b) SCEN-002: a stray solver_id/solverId in the body is IGNORED (never forwarded)", async () => {
    const res = await POST(
      post({
        type: "nequi",
        value: "3001234567",
        solver_id: "victim-solver",
        solverId: "victim-solver",
      }),
    );
    expect(res.status).toBe(200);

    const [, input] = setDonationChannelMock.mock.calls[0];
    // The route forwards ONLY the validated channel shape — no solver id leaks.
    expect(input).toEqual({
      type: "nequi",
      value: "3001234567",
      accountKind: null,
      qrPath: null,
    });
    expect(input).not.toHaveProperty("solver_id");
    expect(input).not.toHaveProperty("solverId");
  });

  it("forwards a qrPath when it is the caller's own owner-keyed object", async () => {
    await POST(
      post({
        type: "nequi",
        value: "3001234567",
        qrPath: "donation-qr/s-1/nequi.png",
      }),
    );
    const [, input] = setDonationChannelMock.mock.calls[0];
    expect(input.qrPath).toBe("donation-qr/s-1/nequi.png");
  });

  it("rejects a qrPath pointing at ANOTHER solver's object (422), service NOT called", async () => {
    const res = await POST(
      post({
        type: "nequi",
        value: "3001234567",
        qrPath: "donation-qr/victim-solver/nequi.png",
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("qr_path_invalid");
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });

  it("rejects a qrPath whose rail does not match the channel type (422)", async () => {
    const res = await POST(
      post({
        type: "nequi",
        value: "3001234567",
        qrPath: "donation-qr/s-1/bancolombia.png",
      }),
    );
    expect(res.status).toBe(422);
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });

  it("rejects a qrPath on a paypal channel (paypal auto-generates, never uploads) (422)", async () => {
    const res = await POST(
      post({
        type: "paypal",
        value: "johndoe",
        qrPath: "donation-qr/s-1/paypal.png",
      }),
    );
    expect(res.status).toBe(422);
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });
});

describe("POST — validation wired (SCEN-006)", () => {
  it("(c) returns 422 for a non-paypal.me PayPal value, service NOT called", async () => {
    const res = await POST(
      post({ type: "paypal", value: "https://evil.com/johndoe" }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("paypal_invalid");
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });

  it("normalizes a valid PayPal username before calling the service", async () => {
    await POST(post({ type: "paypal", value: "johndoe" }));
    const [, input] = setDonationChannelMock.mock.calls[0];
    expect(input.value).toBe("https://paypal.me/johndoe");
  });

  it("returns 422 for an unknown type", async () => {
    const res = await POST(post({ type: "crypto", value: "x" }));
    expect(res.status).toBe(422);
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-JSON body", async () => {
    const res = await POST(post("not json{"));
    expect(res.status).toBe(400);
    expect(setDonationChannelMock).not.toHaveBeenCalled();
  });
});

describe("POST — service error mapping", () => {
  it("(d) maps ForbiddenError to 403", async () => {
    setDonationChannelMock.mockRejectedValue(new ForbiddenError());
    const res = await POST(post({ type: "nequi", value: "3001234567" }));
    expect(res.status).toBe(403);
  });

  it("(d) maps InvalidChannelError to 422", async () => {
    setDonationChannelMock.mockRejectedValue(new InvalidChannelError());
    const res = await POST(post({ type: "nequi", value: "3001234567" }));
    expect(res.status).toBe(422);
  });

  it("maps an unexpected error to 500", async () => {
    setDonationChannelMock.mockRejectedValue(new Error("boom"));
    const res = await POST(post({ type: "nequi", value: "3001234567" }));
    expect(res.status).toBe(500);
  });
});

describe("DELETE", () => {
  it("returns 401 for an anonymous caller", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
    const res = await DELETE(del({ type: "nequi" }));
    expect(res.status).toBe(401);
    expect(deleteDonationChannelMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-solver", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "c-1", role: "citizen" });
    const res = await DELETE(del({ type: "nequi" }));
    expect(res.status).toBe(403);
  });

  it("deletes with the AUTH client and the type, 200", async () => {
    const res = await DELETE(del({ type: "nequi" }));
    expect(res.status).toBe(200);
    const [client, type, meta] = deleteDonationChannelMock.mock.calls[0];
    expect(client).toBe(FAKE_CLIENT);
    expect(type).toBe("nequi");
    expect(meta).toHaveProperty("ip");
  });

  it("returns 422 for an unknown type, service NOT called", async () => {
    const res = await DELETE(del({ type: "crypto" }));
    expect(res.status).toBe(422);
    expect(deleteDonationChannelMock).not.toHaveBeenCalled();
  });

  it("maps ForbiddenError to 403", async () => {
    deleteDonationChannelMock.mockRejectedValue(new ForbiddenError());
    const res = await DELETE(del({ type: "nequi" }));
    expect(res.status).toBe(403);
  });
});
