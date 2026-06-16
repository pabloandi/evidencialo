/**
 * Solver reliability rate (subsystem C) — the SINGLE place the formula and its
 * rounding live, so the service, the UI, and the tests all measure the same
 * thing.
 *
 *   reliability = resolved_count / (resolved_count + reverted_count)
 *
 * The denominator is `resolved + reverted` ONLY — `upheld_count` is a highlighted
 * SUBSET of `resolved_count`, never an additive term (see the design's
 * "Computation & representation").
 *
 * Return contract:
 *   - `denom <= 0` (a freshly verified solver, no resolutions and no reversions)
 *     → `null`. This is the empty sentinel: the view renders "Sin historial aún".
 *     It is NEVER `0` and NEVER `NaN` — a new solver is not "0% reliable", and a
 *     0/0 division must not leak `NaN` into the UI.
 *   - otherwise → a round-half-up integer percent, computed in INTEGER space so
 *     the `.5` boundary is exact. A naive `Math.round((resolved/denom)*100)` is
 *     NOT reliable round-half-up: IEEE-754 underflows some exact halves (e.g.
 *     `23/40 = 57.5%` floats to `57.4999…` → rounds DOWN to 57). Integer
 *     `floor((resolved*200 + denom) / (denom*2))` decides the half by exact
 *     integer division (= `floor(pct + 0.5)`), so `57.5 → 58`, `12.5 → 13`.
 *     Counts are small ints, far under MAX_SAFE_INTEGER, so the products are exact.
 *
 * Note: `reliability(0, 5) === 0` is correct (all resolutions reverted → 0%); only
 * the `0 + 0` case is the `null` sentinel.
 */
export function reliability(
  resolvedCount: number,
  revertedCount: number,
): number | null {
  const denom = resolvedCount + revertedCount;
  if (denom <= 0) return null;
  // Integer round-half-up: floor((pct + 0.5)) without IEEE-754 half-underflow.
  return Math.floor((resolvedCount * 200 + denom) / (denom * 2));
}
