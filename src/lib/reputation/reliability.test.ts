import { describe, expect, it } from "vitest";

import { reliability } from "./reliability";

// Encodes SCEN-006: the reliability rate is a round-half-up integer percent over
// the `resolved + reverted` denominator, with `null` (never 0/NaN) for the empty
// case. This is the single source of truth for the formula + rounding.
describe("reliability", () => {
  it("rounds a normal ratio to an integer percent (47/49 → 96)", () => {
    expect(reliability(47, 2)).toBe(96);
  });

  it("is 100 when there are no reversions", () => {
    expect(reliability(5, 0)).toBe(100);
  });

  it("returns null (never 0/NaN) for the empty case (0 + 0)", () => {
    expect(reliability(0, 0)).toBeNull();
  });

  it("rounds the .5 boundary UP (1/8 = 12.5% → 13)", () => {
    expect(reliability(1, 7)).toBe(13);
  });

  // Float-fault .5 boundaries: the true percent is exactly k.5 but (r/denom)*100
  // underflows to k.4999… in IEEE-754, so a naive Math.round would round DOWN.
  // round-half-up MUST still go up — these are reachable, ordinary solver standings.
  it("rounds .5 UP even when the float underflows the half (23/40 = 57.5% → 58)", () => {
    expect(reliability(23, 17)).toBe(58);
  });

  it("rounds .5 UP at higher volume (29/200 = 14.5% → 15)", () => {
    expect(reliability(29, 171)).toBe(15);
  });

  it("is 0 when every resolution was reverted (0/5 → 0, not the null sentinel)", () => {
    expect(reliability(0, 5)).toBe(0);
  });
});
