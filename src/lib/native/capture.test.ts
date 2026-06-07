import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the capture abstraction (SCEN-003): the SAME `getPosition()` /
 * `isNative()` API selects the native plugin path under Capacitor vs the web API
 * path in a browser, mocking `Capacitor.isNativePlatform()` true/false.
 *
 * `@capacitor/core` and the lazily-imported plugins are mocked so no native
 * binary is needed. Each test imports `capture.ts` fresh (resetModules) so the
 * mocked `isNativePlatform` value is read at call time, not cached.
 */

const isNativePlatform = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform },
}));

const getCurrentPositionNative = vi.fn();
vi.mock("@capacitor/geolocation", () => ({
  Geolocation: { getCurrentPosition: getCurrentPositionNative },
}));

async function loadCapture() {
  vi.resetModules();
  return import("./capture");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("isNative", () => {
  it("is true under Capacitor", async () => {
    isNativePlatform.mockReturnValue(true);
    const { isNative } = await loadCapture();
    expect(isNative()).toBe(true);
  });

  it("is false in a browser", async () => {
    isNativePlatform.mockReturnValue(false);
    const { isNative } = await loadCapture();
    expect(isNative()).toBe(false);
  });
});

describe("getPosition — web path", () => {
  it("resolves {lat,lng} from navigator.geolocation", async () => {
    isNativePlatform.mockReturnValue(false);
    const getCurrentPosition = vi.fn(
      (success: (p: { coords: { latitude: number; longitude: number } }) => void) => {
        success({ coords: { latitude: 4.61, longitude: -74.08 } });
      },
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });

    const { getPosition } = await loadCapture();
    await expect(getPosition()).resolves.toEqual({ lat: 4.61, lng: -74.08 });
    expect(getCurrentPosition).toHaveBeenCalledOnce();
    // Native plugin must NOT be touched on the web path.
    expect(getCurrentPositionNative).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("maps a permission denial (code 1) to a typed CaptureError", async () => {
    isNativePlatform.mockReturnValue(false);
    const getCurrentPosition = vi.fn(
      (_success: unknown, failure: (e: { code: number }) => void) => {
        failure({ code: 1 });
      },
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });

    const { getPosition, CaptureError } = await loadCapture();
    await expect(getPosition()).rejects.toMatchObject({
      name: "CaptureError",
      code: "permission_denied",
    });
    // Sanity: the rejected value is an actual CaptureError instance.
    await getPosition().catch((e) => expect(e).toBeInstanceOf(CaptureError));

    vi.unstubAllGlobals();
  });
});

describe("getPosition — native path", () => {
  it("resolves {lat,lng} from @capacitor/geolocation", async () => {
    isNativePlatform.mockReturnValue(true);
    getCurrentPositionNative.mockResolvedValue({
      coords: { latitude: 10.5, longitude: -66.9 },
    });

    const { getPosition } = await loadCapture();
    await expect(getPosition()).resolves.toEqual({ lat: 10.5, lng: -66.9 });
    expect(getCurrentPositionNative).toHaveBeenCalledOnce();
  });

  it("maps a native permission error to permission_denied", async () => {
    isNativePlatform.mockReturnValue(true);
    getCurrentPositionNative.mockRejectedValue(
      new Error("Location permission was denied"),
    );

    const { getPosition } = await loadCapture();
    await expect(getPosition()).rejects.toMatchObject({
      code: "permission_denied",
    });
  });
});
