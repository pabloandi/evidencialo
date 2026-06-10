import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/reports/[id]/resolution-media (chunk B2.2a).
// getSessionRole + attachResolutionMedia are mocked so the route's ORDER and
// branch logic is the unit under test:
//   solver session -> 201 with the upload contract, service called
//   citizen -> 403, service NOT called
//   service throws ReportNotFoundError -> 404
//   malformed id -> 400 (service not called)
//   invalid body -> 422 (service not called)
// Integration against the live RPC is deferred to B2.5 runtime.

const getSessionRoleMock = vi.fn();
const attachResolutionMediaMock = vi.fn();

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

vi.mock("@/lib/services/resolutionService", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/services/resolutionService")>(
      "@/lib/services/resolutionService",
    );
  return {
    ...actual,
    attachResolutionMedia: (...args: unknown[]) =>
      attachResolutionMediaMock(...args),
  };
});

import { ReportNotFoundError } from "@/lib/services/resolutionService";
import { POST } from "./route";

const VALID_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const VALID_MEDIA = [
  { type: "image", mime: "image/jpeg", size: 1000 },
];

function makeRequest(id: string, body: unknown) {
  return {
    request: new Request(
      `http://localhost/api/reports/${id}/resolution-media`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    ctx: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  getSessionRoleMock.mockReset();
  attachResolutionMediaMock.mockReset();
  // Default: a solver session under test unless a case overrides it.
  getSessionRoleMock.mockResolvedValue({ userId: "solver-1", role: "solver" });
});

describe("POST /api/reports/[id]/resolution-media", () => {
  it("returns 201 with the upload contract for a solver session", async () => {
    attachResolutionMediaMock.mockResolvedValue({
      media: [
        {
          id: "m-1",
          type: "image",
          signedUrl: "https://signed/url",
          token: "tok-1",
          path: `${VALID_ID}/resolution/0.jpg`,
        },
      ],
    });
    const { request, ctx } = makeRequest(VALID_ID, { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      media: [
        {
          id: "m-1",
          type: "image",
          upload: {
            signedUrl: "https://signed/url",
            token: "tok-1",
            path: `${VALID_ID}/resolution/0.jpg`,
          },
        },
      ],
    });
    expect(attachResolutionMediaMock).toHaveBeenCalledWith(
      VALID_ID,
      VALID_MEDIA,
    );
  });

  it("returns 403 for an authenticated citizen and never calls the service", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "u-1", role: "citizen" });
    const { request, ctx } = makeRequest(VALID_ID, { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
    expect(attachResolutionMediaMock).not.toHaveBeenCalled();
  });

  it("returns 403 for an anonymous caller (role null) and never calls the service", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: null, role: null });
    const { request, ctx } = makeRequest(VALID_ID, { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(attachResolutionMediaMock).not.toHaveBeenCalled();
  });

  it("treats a getSessionRole throw as anonymous -> 403 (fail closed)", async () => {
    getSessionRoleMock.mockRejectedValue(new Error("supabase boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID, { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(403);
    expect(attachResolutionMediaMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("lets a staff session through (universal proof gate)", async () => {
    getSessionRoleMock.mockResolvedValue({ userId: "s-1", role: "staff" });
    attachResolutionMediaMock.mockResolvedValue({ media: [] });
    const { request, ctx } = makeRequest(VALID_ID, { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(201);
    expect(attachResolutionMediaMock).toHaveBeenCalled();
  });

  it("returns 400 for a malformed id without calling the service", async () => {
    const { request, ctx } = makeRequest("not-a-uuid", { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("id_invalid");
    expect(attachResolutionMediaMock).not.toHaveBeenCalled();
  });

  it("returns 422 for an unparseable body", async () => {
    const { request, ctx } = makeRequest(VALID_ID, "{not json");

    const res = await POST(request, ctx);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_payload");
    expect(attachResolutionMediaMock).not.toHaveBeenCalled();
  });

  it("returns 422 for an invalid media payload (empty array) without calling the service", async () => {
    const { request, ctx } = makeRequest(VALID_ID, { media: [] });

    const res = await POST(request, ctx);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("media_required");
    expect(attachResolutionMediaMock).not.toHaveBeenCalled();
  });

  it("returns 422 for a disallowed media format without calling the service", async () => {
    const { request, ctx } = makeRequest(VALID_ID, {
      media: [{ type: "image", mime: "image/gif", size: 1000 }],
    });

    const res = await POST(request, ctx);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("media_format_invalid");
    expect(attachResolutionMediaMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the service reports an unknown report", async () => {
    attachResolutionMediaMock.mockRejectedValue(
      new ReportNotFoundError(VALID_ID),
    );
    const { request, ctx } = makeRequest(VALID_ID, { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns 500 for an unexpected service failure", async () => {
    attachResolutionMediaMock.mockRejectedValue(new Error("db is on fire"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { request, ctx } = makeRequest(VALID_ID, { media: VALID_MEDIA });

    const res = await POST(request, ctx);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    errorSpy.mockRestore();
  });
});
