import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/solver/donation-qr (D2, SCEN-007). The owner
// gate, rate-limit, sanitizer, and admin client are mocked so the route's branch
// logic is the unit under test:
//   anon -> 401, non-solver -> 403 (sanitizer NOT invoked, no upload);
//   sanitizer IS invoked on a valid upload; a non-image -> 422;
//   success stores at donation-qr/<userId>/<type>.png (admin client) -> 200 { qrPath };
//   rate-limited -> 429.

const getSessionRoleMock = vi.fn();
const checkRateLimitMock = vi.fn();
const sanitizeQrImageMock = vi.fn();
const createAdminSupabaseMock = vi.fn();
const uploadMock = vi.fn();

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

vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
}));

vi.mock("@/lib/donation/qrImage", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/donation/qrImage")>(
      "@/lib/donation/qrImage",
    );
  return {
    ...actual,
    sanitizeQrImage: (...args: unknown[]) => sanitizeQrImageMock(...args),
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabase: (...args: unknown[]) => createAdminSupabaseMock(...args),
}));

import { InvalidQrImageError } from "@/lib/donation/qrImage";
import { POST } from "./route";

/** Build a multipart request with an optional file + type field. */
function multipart(opts: { type?: string; file?: Blob | null }): Request {
  const form = new FormData();
  if (opts.type !== undefined) form.set("type", opts.type);
  if (opts.file !== undefined && opts.file !== null) {
    form.set("file", opts.file, "qr.png");
  }
  return new Request("http://localhost/api/solver/donation-qr", {
    method: "POST",
    body: form,
  });
}

const FAKE_PNG = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });

beforeEach(() => {
  getSessionRoleMock.mockReset();
  checkRateLimitMock.mockReset();
  sanitizeQrImageMock.mockReset();
  createAdminSupabaseMock.mockReset();
  uploadMock.mockReset();

  getSessionRoleMock.mockResolvedValue({ userId: "s-1", role: "solver" });
  checkRateLimitMock.mockResolvedValue({ allowed: true });
  sanitizeQrImageMock.mockResolvedValue({
    data: Buffer.from([9, 9, 9]),
    contentType: "image/png",
    width: 512,
    height: 512,
  });
  uploadMock.mockResolvedValue({ data: { path: "x" }, error: null });
  createAdminSupabaseMock.mockReturnValue({
    storage: { from: () => ({ upload: uploadMock }) },
  });
});

describe("POST /api/solver/donation-qr — owner gate", () => {
  it("returns 401 for anon, sanitizer NOT invoked", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
    const res = await POST(multipart({ type: "nequi", file: FAKE_PNG }));
    expect(res.status).toBe(401);
    expect(sanitizeQrImageMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-solver, sanitizer NOT invoked", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "c-1", role: "citizen" });
    const res = await POST(multipart({ type: "nequi", file: FAKE_PNG }));
    expect(res.status).toBe(403);
    expect(sanitizeQrImageMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/solver/donation-qr — rate-limit", () => {
  it("returns 429 when rate-limited", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false });
    const res = await POST(multipart({ type: "nequi", file: FAKE_PNG }));
    expect(res.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith("user:s-1");
    expect(sanitizeQrImageMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/solver/donation-qr — body validation", () => {
  it("returns 422 for an unknown type", async () => {
    const res = await POST(multipart({ type: "crypto", file: FAKE_PNG }));
    expect(res.status).toBe(422);
    expect(sanitizeQrImageMock).not.toHaveBeenCalled();
  });

  it("returns 422 for the paypal type (paypal never uploads a QR)", async () => {
    const res = await POST(multipart({ type: "paypal", file: FAKE_PNG }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when the file is missing", async () => {
    const res = await POST(multipart({ type: "nequi", file: null }));
    expect(res.status).toBe(422);
    expect(sanitizeQrImageMock).not.toHaveBeenCalled();
  });

  it("returns 413 when the file exceeds the 8 MB cap, sanitizer NOT invoked", async () => {
    const tooBig = new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], {
      type: "image/png",
    });
    const res = await POST(multipart({ type: "nequi", file: tooBig }));
    expect(res.status).toBe(413);
    expect(sanitizeQrImageMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/solver/donation-qr — sanitize + store", () => {
  it("invokes the sanitizer and stores at donation-qr/<userId>/<type>.png", async () => {
    const res = await POST(multipart({ type: "nequi", file: FAKE_PNG }));
    expect(res.status).toBe(200);

    // The sanitizer ran on the uploaded bytes.
    expect(sanitizeQrImageMock).toHaveBeenCalledTimes(1);

    // The upload used the SERVICE-ROLE admin client at the owner-keyed path.
    expect(createAdminSupabaseMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, , opts] = uploadMock.mock.calls[0];
    expect(path).toBe("s-1/nequi.png");
    expect(opts).toMatchObject({ upsert: true, contentType: "image/png" });

    const body = await res.json();
    expect(body.qrPath).toBe("donation-qr/s-1/nequi.png");
  });

  it("returns 422 when the sanitizer rejects a non-image", async () => {
    sanitizeQrImageMock.mockRejectedValue(new InvalidQrImageError());
    const res = await POST(multipart({ type: "nequi", file: FAKE_PNG }));
    expect(res.status).toBe(422);
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns 503 when the storage upload fails", async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: "down" } });
    const res = await POST(multipart({ type: "nequi", file: FAKE_PNG }));
    expect(res.status).toBe(503);
  });
});
