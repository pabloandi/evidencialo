// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CaptureForm from "./CaptureForm";

/**
 * CaptureForm unit tests (SCEN-001 payload/sequence + SCEN-002 validation).
 *
 * `fetch`, the browser Supabase client and `crypto.randomUUID` are mocked so the
 * test asserts the EXACT submit contract without a network or storage. The form
 * is treated as the web (non-native) path: `isNative()` returns false (the
 * default since `Capacitor.isNativePlatform` is mocked false), so only the file
 * input is rendered.
 */

const uploadToSignedUrl = vi.fn();
const getSession = vi.fn();
const categoriesSelect = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabase: () => ({
    auth: { getSession },
    from: () => ({
      select: () => ({ order: categoriesSelect }),
    }),
    storage: {
      from: () => ({ uploadToSignedUrl }),
    },
  }),
}));

// A signed-in citizen by default (captcha-exempt) → no Turnstile dependency.
function signedInSession() {
  getSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
}

function withCategories() {
  categoriesSelect.mockResolvedValue({
    data: [{ slug: "bache", name: "Bache" }],
  });
}

beforeEach(() => {
  signedInSession();
  withCategories();
  uploadToSignedUrl.mockResolvedValue({ error: null });
  // jsdom lacks the object-URL API the preview uses; stub to no-ops.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "crypto",
    { ...globalThis.crypto, randomUUID: () => "idem-key-123" },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function makePhoto(): File {
  return new File([new Uint8Array([1, 2, 3])], "foto.jpg", {
    type: "image/jpeg",
  });
}

describe("SCEN-002: incomplete submission is blocked client-side", () => {
  it("blocks submit and makes NO network call when the photo is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<CaptureForm />);
    await screen.findByRole("option", { name: "Bache" });

    // Provide everything EXCEPT the photo: category + location.
    await user.selectOptions(
      screen.getByLabelText("Categoría"),
      "bache",
    );
    // (location intentionally not captured either — first missing field is photo)

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect((await screen.findByRole("alert")).textContent ?? "").toMatch(/foto/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks submit when category is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<CaptureForm />);
    await screen.findByRole("option", { name: "Bache" });

    await user.upload(
      screen.getByLabelText("Foto del problema"),
      makePhoto(),
    );

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect((await screen.findByRole("alert")).textContent ?? "").toMatch(/categoría/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks submit when location is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<CaptureForm />);
    await screen.findByRole("option", { name: "Bache" });

    await user.upload(
      screen.getByLabelText("Foto del problema"),
      makePhoto(),
    );
    await user.selectOptions(screen.getByLabelText("Categoría"), "bache");

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect((await screen.findByRole("alert")).textContent ?? "").toMatch(/ubicación/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SCEN-001: a complete submission runs the full chain in order", () => {
  it("POST /api/reports → uploadToSignedUrl → POST /api/media with the right payload", async () => {
    // Capture geolocation so "Usar mi ubicación" yields coords.
    const getCurrentPosition = vi.fn(
      (success: (p: { coords: { latitude: number; longitude: number } }) => void) => {
        success({ coords: { latitude: 4.61, longitude: -74.08 } });
      },
    );
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init; // recorded in mock.calls for the header/body assertions below
      if (url === "/api/reports") {
        return {
          ok: true,
          json: async () => ({
            report_id: "report-1",
            media: [
              {
                id: "media-1",
                type: "image",
                upload: {
                  signedUrl: "https://signed/upload",
                  token: "tok-1",
                  path: "report-1/media-1.jpg",
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

    const user = userEvent.setup();
    render(<CaptureForm />);
    await screen.findByRole("option", { name: "Bache" });

    await user.upload(screen.getByLabelText("Foto del problema"), makePhoto());
    await user.selectOptions(screen.getByLabelText("Categoría"), "bache");
    await user.type(
      screen.getByLabelText(/Descripción/),
      "Hueco grande",
    );
    await user.click(
      screen.getByRole("button", { name: "Usar mi ubicación" }),
    );
    await screen.findByText(/Ubicación capturada/);

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    // Success panel appears once the chain completes.
    await screen.findByText("¡Reporte enviado!");

    // 1) POST /api/reports — body + Idempotency-Key header.
    const reportsCall = fetchMock.mock.calls.find((c) => c[0] === "/api/reports");
    expect(reportsCall).toBeTruthy();
    const reqInit = reportsCall![1] as RequestInit;
    expect((reqInit.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "idem-key-123",
    );
    expect(JSON.parse(reqInit.body as string)).toEqual({
      category: "bache",
      lng: -74.08,
      lat: 4.61,
      description: "Hueco grande",
      media: [{ type: "image", mime: "image/jpeg", size: 3 }],
    });

    // 2) uploadToSignedUrl(path, token, file).
    expect(uploadToSignedUrl).toHaveBeenCalledWith(
      "report-1/media-1.jpg",
      "tok-1",
      expect.any(File),
    );

    // 3) POST /api/media { report_id, media_id }.
    const mediaCall = fetchMock.mock.calls.find((c) => c[0] === "/api/media");
    expect(mediaCall).toBeTruthy();
    expect(JSON.parse((mediaCall![1] as RequestInit).body as string)).toEqual({
      report_id: "report-1",
      media_id: "media-1",
    });

    // Ordering: reports before media; upload between them.
    const reportsIdx = fetchMock.mock.invocationCallOrder[
      fetchMock.mock.calls.findIndex((c) => c[0] === "/api/reports")
    ];
    const mediaIdx = fetchMock.mock.invocationCallOrder[
      fetchMock.mock.calls.findIndex((c) => c[0] === "/api/media")
    ];
    expect(reportsIdx).toBeLessThan(mediaIdx);
    expect(uploadToSignedUrl.mock.invocationCallOrder[0]).toBeGreaterThan(
      reportsIdx,
    );
    expect(uploadToSignedUrl.mock.invocationCallOrder[0]).toBeLessThan(mediaIdx);
  });
});
