/**
 * Pins the shared map config so `MapView` and `LocationPicker` can never drift
 * from the values MapView shipped before the extraction (location-picker Step 1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasMapKey, INITIAL_CENTER, INITIAL_ZOOM, mapStyleUrl } from "./config";

describe("map config", () => {
  it("keeps the exact Bogotá viewport MapView shipped", () => {
    // Byte-for-byte the prior MapView local constants.
    expect(INITIAL_CENTER).toEqual([-74.08, 4.61]);
    expect(INITIAL_ZOOM).toBe(12);
  });

  describe("with NEXT_PUBLIC_MAPTILER_KEY set", () => {
    const original = process.env.NEXT_PUBLIC_MAPTILER_KEY;

    beforeEach(() => {
      process.env.NEXT_PUBLIC_MAPTILER_KEY = "test-key";
    });
    afterEach(() => {
      process.env.NEXT_PUBLIC_MAPTILER_KEY = original;
    });

    it("builds the dataviz style URL byte-identical to the old inline string", () => {
      expect(mapStyleUrl()).toBe(
        "https://api.maptiler.com/maps/dataviz/style.json?key=test-key",
      );
    });

    it("reports the key as present", () => {
      expect(hasMapKey()).toBe(true);
    });
  });

  describe("without NEXT_PUBLIC_MAPTILER_KEY", () => {
    const original = process.env.NEXT_PUBLIC_MAPTILER_KEY;

    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_MAPTILER_KEY;
    });
    afterEach(() => {
      process.env.NEXT_PUBLIC_MAPTILER_KEY = original;
    });

    it("reports the key as absent (drives the fallback path)", () => {
      expect(hasMapKey()).toBe(false);
    });
  });
});
