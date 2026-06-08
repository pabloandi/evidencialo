// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptureError } from "@/lib/native/capture";

import LocationPicker from "./LocationPicker";

/**
 * LocationPicker unit tests — the SDD holdout for Steps 2/3/5
 * (SCEN-001, SCEN-002, SCEN-005 from `location-picker.scenarios.md`).
 *
 * MapLibre is mocked with a fake `Map` whose center is a settable `{lng,lat}`
 * (maplibre's own order) so the test can simulate a pan and assert that
 * "Confirmar" reads `getCenter()` at the moment of confirm. `getPosition` is
 * mocked so the "Usar mi ubicación" / GPS-denied paths are deterministic.
 *
 * Every method the component calls on the map MUST be stubbed — a missing one
 * throws at runtime — so the fake exposes `getCenter`, `flyTo`, `on`,
 * `addControl`, `getCanvas`, and `remove`.
 */

// Shared handle to the fake map so assertions can read/mutate its center.
type FakeCenter = { lng: number; lat: number };

const mapState: {
  center: FakeCenter;
  flyTo: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  addControl: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  // captured `error` listener so a test can fire a runtime map error.
  errorHandler: ((e: unknown) => void) | null;
} = {
  center: { lng: 0, lat: 0 },
  flyTo: vi.fn(),
  on: vi.fn(),
  addControl: vi.fn(),
  remove: vi.fn(),
  errorHandler: null,
};

function makeFakeMap() {
  return {
    getCenter: () => ({ lng: mapState.center.lng, lat: mapState.center.lat }),
    flyTo: mapState.flyTo,
    on: mapState.on,
    addControl: mapState.addControl,
    getCanvas: () => ({ style: {} }),
    remove: mapState.remove,
  };
}

vi.mock("maplibre-gl", () => {
  class Map {
    constructor() {
      return makeFakeMap() as unknown as Map;
    }
  }
  class NavigationControl {}
  return { default: { Map, NavigationControl } };
});

const getPosition = vi.fn();
vi.mock("@/lib/native/capture", async () => {
  const actual = await vi.importActual<typeof import("@/lib/native/capture")>(
    "@/lib/native/capture",
  );
  return { ...actual, getPosition: (...args: unknown[]) => getPosition(...args) };
});

beforeEach(() => {
  // hasMapKey()/mapStyleUrl() read process.env at call-time → set before render.
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "test-key");
  mapState.center = { lng: 0, lat: 0 };
  mapState.flyTo.mockReset();
  mapState.addControl.mockReset();
  mapState.remove.mockReset();
  mapState.errorHandler = null;
  // Record the `error` listener so a test can fire a runtime failure.
  mapState.on.mockReset();
  mapState.on.mockImplementation((event: string, handler: (e: unknown) => void) => {
    if (event === "error") mapState.errorHandler = handler;
  });
  getPosition.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const initialCenter = { lat: 4.61, lng: -74.08 };

describe("SCEN-001: confirm returns the map center, not the GPS point", () => {
  it("Confirmar calls onConfirm once with the current map center as {lat,lng}", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    // Simulate the user dragging the map: the fake map center moves to a point
    // that is NOT the initial center / GPS.
    mapState.center = { lng: -74.05, lat: 4.65 };

    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // maplibre returns {lng,lat}; the picker must map it to {lat,lng}.
    expect(onConfirm).toHaveBeenCalledWith({ lat: 4.65, lng: -74.05 });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("SCEN-002: 'usar mi ubicación' is a starting point, not the final value", () => {
  it("flyTo gets the GPS center; a later pan + confirm returns the panned center", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    getPosition.mockResolvedValue({ lat: 10.5, lng: -75.5 });

    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Usar mi ubicación" }));

    // flyTo received the GPS point as [lng, lat].
    await waitFor(() =>
      expect(mapState.flyTo).toHaveBeenCalledWith({ center: [-75.5, 10.5] }),
    );

    // The user pans AWAY from the GPS fix before confirming.
    mapState.center = { lng: -74.0, lat: 4.7 };

    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    // Confirmed point is the panned center, NOT the GPS fix.
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ lat: 4.7, lng: -74.0 });
  });
});

describe("SCEN-005: GPS denied — manual pick still works", () => {
  it("shows the non-blocking note without throwing, and confirm still works", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    getPosition.mockRejectedValue(
      new CaptureError("permission_denied", "denied"),
    );

    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Usar mi ubicación" }));

    expect(
      await screen.findByText(
        "No pudimos obtener tu ubicación; mueve el mapa para fijar el punto.",
      ),
    ).toBeTruthy();

    // The user can still pan + confirm a point the picker accepts.
    mapState.center = { lng: -74.02, lat: 4.62 };
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({ lat: 4.62, lng: -74.02 });
  });
});

describe("Cancel: never confirms", () => {
  it("Cancelar calls onCancel and never onConfirm", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("a11y (Step 5): Escape cancels", () => {
  it("pressing Escape calls onCancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders a modal dialog with a focused element inside the sheet", () => {
    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Focus was moved into the sheet on open.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("Step 3: map init failure — missing key", () => {
  it("with no MapTiler key, renders the error state and creates no map", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
    const onCancel = vi.fn();

    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    // No map was created → no NavigationControl registered.
    expect(mapState.addControl).not.toHaveBeenCalled();
    // A readable error + a Cancelar (no map) is available.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    // Confirmar is NOT offered when there is no map to read a center from.
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });
});

describe("Step 3: runtime map error surfaces a readable message", () => {
  it("a fired map 'error' event shows a message and keeps Cancelar available", async () => {
    const onCancel = vi.fn();

    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    // The component registered an `error` listener; fire a runtime failure.
    expect(mapState.errorHandler).toBeTypeOf("function");
    mapState.errorHandler?.({ error: new Error("WebGL unavailable") });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
  });
});

describe("lifecycle: no setState after unmount during a pending GPS request (HIGH)", () => {
  // The HIGH regression: the web `getPosition()` has a 15s timeout, so a user
  // can unmount the picker with a request still pending. When it settles the
  // async continuation must short-circuit on `mountedRef` and NOT touch the map
  // or run state work on the dead component.
  //
  // The guard is observed through `flyTo`: with `mountedRef`, a GPS fix that
  // resolves AFTER unmount returns BEFORE `flyTo` (0 calls); without the guard
  // the continuation falls through to `mapRef.current?.flyTo(...)`. The control
  // below proves `flyTo` IS the live signal on the mounted path, so the
  // post-unmount "0 calls" is the guard taking the early return — not a dead
  // path that could never fire.

  it("CONTROL (mounted): a resolved GPS fix flies to the GPS point", async () => {
    let resolveGps: (point: { lat: number; lng: number }) => void = () => {};
    const gpsPromise = new Promise<{ lat: number; lng: number }>((resolve) => {
      resolveGps = resolve;
    });
    getPosition.mockReturnValue(gpsPromise);

    const user = userEvent.setup();
    render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Usar mi ubicación" }));

    // Resolve while STILL MOUNTED → the guard passes, flyTo runs.
    resolveGps({ lat: 9.9, lng: -75.1 });
    await waitFor(() =>
      expect(mapState.flyTo).toHaveBeenCalledWith({ center: [-75.1, 9.9] }),
    );
  });

  it("resolves getPosition AFTER unmount → guard returns before flyTo, no throw", async () => {
    let resolveGps: (point: { lat: number; lng: number }) => void = () => {};
    const gpsPromise = new Promise<{ lat: number; lng: number }>((resolve) => {
      resolveGps = resolve;
    });
    getPosition.mockReturnValue(gpsPromise);

    const user = userEvent.setup();
    const { unmount } = render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Usar mi ubicación" }));

    // The user cancels/unmounts while the GPS request is still pending; the map
    // ref is alive here (the fake `remove` is a no-op), so reaching `flyTo`
    // would mean the guard did NOT short-circuit.
    unmount();

    // The request settles AFTER unmount. The `mountedRef` guard must return
    // before flyTo and must not throw.
    let threw = false;
    try {
      resolveGps({ lat: 1, lng: 2 });
      await gpsPromise;
      await Promise.resolve();
      await Promise.resolve();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // No post-unmount flyTo: the guard's early return held.
    expect(mapState.flyTo).not.toHaveBeenCalled();
  });
});

describe("lifecycle: map is removed on unmount", () => {
  it("calls map.remove() when the picker unmounts", () => {
    const { unmount } = render(
      <LocationPicker
        initialCenter={initialCenter}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    unmount();
    expect(mapState.remove).toHaveBeenCalledTimes(1);
  });
});
