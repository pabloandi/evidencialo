import { describe, expect, it } from "vitest";

import { parseBbox } from "./geo";

// Unit contract for parseBbox — the bbox query string parser for the public map
// read API (public-map-bbox.scenarios.md, SCEN-003). A bbox is
// "minLng,minLat,maxLng,maxLat": exactly 4 finite numbers, within lng/lat
// ranges, with min < max on both axes, and an anti-abuse area cap of 5° per
// axis. Anything else is a structured error, never an unbounded scan.

describe("parseBbox", () => {
  it("parses a valid city-sized bbox", () => {
    const result = parseBbox("-74.10,4.60,-74.06,4.62");
    expect(result).toEqual({
      ok: true,
      value: { minLng: -74.1, minLat: 4.6, maxLng: -74.06, maxLat: 4.62 },
    });
  });

  it("rejects a null bbox as bbox_invalid", () => {
    const result = parseBbox(null);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects an empty bbox as bbox_invalid", () => {
    const result = parseBbox("");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects a bbox with only 3 numbers as bbox_invalid", () => {
    const result = parseBbox("-74.10,4.60,-74.06");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects a bbox with 5 numbers as bbox_invalid", () => {
    const result = parseBbox("-74.10,4.60,-74.06,4.62,1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects a non-numeric component as bbox_invalid", () => {
    const result = parseBbox("-74.10,abc,-74.06,4.62");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects NaN/Infinity components as bbox_invalid", () => {
    expect(parseBbox("NaN,4.60,-74.06,4.62").ok).toBe(false);
    expect(parseBbox("Infinity,4.60,-74.06,4.62").ok).toBe(false);
  });

  it("rejects minLng >= maxLng as bbox_invalid", () => {
    const result = parseBbox("-74.06,4.60,-74.10,4.62"); // min > max on lng
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects minLat >= maxLat as bbox_invalid", () => {
    const result = parseBbox("-74.10,4.62,-74.06,4.60"); // min > max on lat
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects an out-of-range longitude as bbox_invalid", () => {
    const result = parseBbox("-181,4.60,-74.06,4.62");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects an out-of-range latitude as bbox_invalid", () => {
    const result = parseBbox("-74.10,4.60,-74.06,91");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_invalid");
  });

  it("rejects a bbox spanning more than 5° of longitude as bbox_too_large", () => {
    const result = parseBbox("-80,4.60,-74,4.62"); // 6° lng span
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_too_large");
  });

  it("rejects a bbox spanning more than 5° of latitude as bbox_too_large", () => {
    const result = parseBbox("-74.10,4,-74.06,10"); // 6° lat span
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_too_large");
  });

  it("rejects a whole-world bbox as bbox_too_large", () => {
    const result = parseBbox("-180,-90,180,90");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("bbox_too_large");
  });

  it("accepts a bbox exactly at the 5° cap", () => {
    const result = parseBbox("-74,4,-69,9"); // exactly 5° on both axes
    expect(result.ok).toBe(true);
  });
});
