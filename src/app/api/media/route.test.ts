import { beforeEach, describe, expect, it, vi } from "vitest";

// Observable contract for POST /api/media. processMedia is mocked so the unit
// under test is the route's validation + status/error mapping (SCEN-005 invalid
// body -> 422, SCEN-006 not found -> 404, SCEN-007 processing failed -> 422,
// happy path -> 200).

const processMediaMock = vi.fn();

vi.mock("@/lib/services/mediaService", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/mediaService")
  >("@/lib/services/mediaService");
  return {
    ...actual,
    processMedia: (...args: unknown[]) => processMediaMock(...args),
  };
});

import {
  MediaNotFoundError,
  MediaNotReadyError,
  MediaProcessingError,
  MediaWriteError,
  UnsupportedMediaError,
} from "@/lib/services/mediaService";
import { POST } from "./route";

// Valid RFC 9562 v4 UUIDs (zod v4's `.uuid()` enforces version/variant bits).
const REPORT_ID = "e06d85a2-6961-4deb-9342-6d3b9ec69bb9";
const MEDIA_ID = "96e469d9-5238-4f35-afad-8699e594a865";

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/media", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  processMediaMock.mockReset();
});

describe("POST /api/media", () => {
  it("returns 200 with the processed result on success (SCEN-002)", async () => {
    processMediaMock.mockResolvedValue({
      state: "processed",
      width: 240,
      height: 160,
    });

    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: MEDIA_ID }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      media_id: MEDIA_ID,
      processing_state: "processed",
      width: 240,
      height: 160,
    });
    expect(processMediaMock).toHaveBeenCalledWith({
      reportId: REPORT_ID,
      mediaId: MEDIA_ID,
    });
  });

  it("returns 422 invalid_payload for a non-UUID media_id without processing (SCEN-005)", async () => {
    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: "not-a-uuid" }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "invalid_payload",
        message: "Cuerpo de la petición inválido.",
      },
    });
    expect(processMediaMock).not.toHaveBeenCalled();
  });

  it("returns 422 invalid_payload for a missing report_id (SCEN-005)", async () => {
    const res = await POST(makeRequest({ media_id: MEDIA_ID }));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_payload");
    expect(processMediaMock).not.toHaveBeenCalled();
  });

  it("returns 422 invalid_payload for an unparseable body (SCEN-005)", async () => {
    const res = await POST(makeRequest("{not json"));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_payload");
    expect(processMediaMock).not.toHaveBeenCalled();
  });

  it("returns 404 media_not_found when the service raises MediaNotFoundError (SCEN-006)", async () => {
    processMediaMock.mockRejectedValue(new MediaNotFoundError(MEDIA_ID));

    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: MEDIA_ID }),
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "media_not_found", message: "Media no encontrada." },
    });
  });

  it("returns 422 unsupported_media for a non-image row", async () => {
    processMediaMock.mockRejectedValue(new UnsupportedMediaError("video"));

    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: MEDIA_ID }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "unsupported_media",
        message: "Tipo de media no soportado.",
      },
    });
  });

  it("returns 422 media_processing_failed when processing fails (SCEN-007)", async () => {
    processMediaMock.mockRejectedValue(
      new MediaProcessingError("corrupt input"),
    );

    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: MEDIA_ID }),
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "media_processing_failed",
        message: "No se pudo procesar la imagen.",
      },
    });
  });

  it("returns 409 media_not_ready when the raw object is not yet uploaded (SCEN-H04)", async () => {
    processMediaMock.mockRejectedValue(new MediaNotReadyError(MEDIA_ID));

    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: MEDIA_ID }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "media_not_ready",
        message: "La imagen aún no está disponible. Reintenta.",
      },
    });
  });

  it("returns 503 media_write_failed on a transient write error (SCEN-H02)", async () => {
    processMediaMock.mockRejectedValue(
      new MediaWriteError("upload 503"),
    );

    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: MEDIA_ID }),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "media_write_failed",
        message: "Error temporal al guardar. Inténtalo de nuevo.",
      },
    });
  });

  it("returns 500 for an unexpected service failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processMediaMock.mockRejectedValue(new Error("storage is on fire"));

    const res = await POST(
      makeRequest({ report_id: REPORT_ID, media_id: MEDIA_ID }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal_error");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
