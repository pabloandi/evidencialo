// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ResolutionUpload from "./ResolutionUpload";

/**
 * ResolutionUpload unit tests (solver-resolution SCEN-002).
 *
 * The happy path must run the SAME chain CaptureForm uses, against the
 * resolution-media route: POST /api/reports/[id]/resolution-media → signed-URL
 * PUT (uploadToSignedUrl) → POST /api/media — in that order. `fetch`, the
 * browser Supabase client and the object-URL API are mocked.
 */

const uploadToSignedUrl = vi.fn();

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabase: () => ({
    storage: { from: () => ({ uploadToSignedUrl }) },
  }),
}));

beforeEach(() => {
  uploadToSignedUrl.mockResolvedValue({ error: null });
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function makeImage(): File {
  return new File([new Uint8Array([1, 2, 3])], "proof.jpg", {
    type: "image/jpeg",
  });
}

describe("happy path", () => {
  it("attaches → uploads bytes → processes the image, in order, then notifies", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      if (url === "/api/reports/rep-1/resolution-media") {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            media: [
              {
                id: "media-9",
                type: "image",
                upload: {
                  signedUrl: "https://signed/upload",
                  token: "tok-9",
                  path: "rep-1/media-9.jpg",
                },
              },
            ],
          }),
        };
      }
      if (url === "/api/media") {
        return { ok: true, json: async () => ({ processing_state: "done" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onUploaded = vi.fn();
    const user = userEvent.setup();
    render(<ResolutionUpload reportId="rep-1" onUploaded={onUploaded} />);

    await user.upload(
      screen.getByLabelText("Evidencia del arreglo"),
      makeImage(),
    );
    await user.click(
      screen.getByRole("button", { name: "Subir evidencia" }),
    );

    // 1) resolution-media manifest.
    const attachCall = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/reports/rep-1/resolution-media",
    );
    expect(attachCall).toBeTruthy();
    expect(JSON.parse((attachCall![1] as RequestInit).body as string)).toEqual({
      media: [{ type: "image", mime: "image/jpeg", size: 3 }],
    });

    // 2) signed-URL PUT.
    expect(uploadToSignedUrl).toHaveBeenCalledWith(
      "rep-1/media-9.jpg",
      "tok-9",
      expect.any(File),
    );

    // 3) /api/media processing.
    const mediaCall = fetchMock.mock.calls.find((c) => c[0] === "/api/media");
    expect(mediaCall).toBeTruthy();
    expect(JSON.parse((mediaCall![1] as RequestInit).body as string)).toEqual({
      report_id: "rep-1",
      media_id: "media-9",
    });

    // Ordering: attach < upload < process.
    const attachIdx =
      fetchMock.mock.invocationCallOrder[
        fetchMock.mock.calls.findIndex(
          (c) => c[0] === "/api/reports/rep-1/resolution-media",
        )
      ];
    const mediaIdx =
      fetchMock.mock.invocationCallOrder[
        fetchMock.mock.calls.findIndex((c) => c[0] === "/api/media")
      ];
    expect(attachIdx).toBeLessThan(uploadToSignedUrl.mock.invocationCallOrder[0]);
    expect(uploadToSignedUrl.mock.invocationCallOrder[0]).toBeLessThan(mediaIdx);

    // 4) parent notified to refresh.
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });
});

describe("failure handling", () => {
  it("surfaces an error and does NOT notify when the attach step fails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({
        error: { code: "invalid_payload", message: "Cuerpo de la petición inválido." },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const onUploaded = vi.fn();
    const user = userEvent.setup();
    render(<ResolutionUpload reportId="rep-1" onUploaded={onUploaded} />);

    await user.upload(
      screen.getByLabelText("Evidencia del arreglo"),
      makeImage(),
    );
    await user.click(screen.getByRole("button", { name: "Subir evidencia" }));

    expect((await screen.findByRole("alert")).textContent ?? "").toMatch(
      /inválido/i,
    );
    expect(uploadToSignedUrl).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("surfaces an error when the signed-URL upload fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/reports/rep-1/resolution-media") {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            media: [
              {
                id: "media-9",
                type: "image",
                upload: {
                  signedUrl: "https://signed/upload",
                  token: "tok-9",
                  path: "rep-1/media-9.jpg",
                },
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    uploadToSignedUrl.mockResolvedValue({ error: { message: "boom" } });

    const onUploaded = vi.fn();
    const user = userEvent.setup();
    render(<ResolutionUpload reportId="rep-1" onUploaded={onUploaded} />);

    await user.upload(
      screen.getByLabelText("Evidencia del arreglo"),
      makeImage(),
    );
    await user.click(screen.getByRole("button", { name: "Subir evidencia" }));

    expect((await screen.findByRole("alert")).textContent ?? "").toMatch(
      /no se pudo subir/i,
    );
    // /api/media must NOT be reached after an upload failure.
    expect(fetchMock.mock.calls.some((c) => c[0] === "/api/media")).toBe(false);
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
