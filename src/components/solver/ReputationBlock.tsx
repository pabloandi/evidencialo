/**
 * Public solver reputation block (subsystem C, chunk C3) — the presentational
 * counts + reliability rate shown in `ProfileHeader` on
 * `/solucionadores/[handle]` (SCEN-007).
 *
 * Purely presentational (no hooks, no fetch) so it renders identically in any
 * RSC tree — it mirrors `CorroboratedBadge`'s structure. It shows:
 *   - the reliability chip "X% fiable" (the accent-filled pill), and
 *   - a counts line "N resueltos[ (M sostenidas en disputa)][ · K revertidas]",
 *     singular/plural-aware. The "(… sostenidas en disputa)" parenthetical
 *     signals that `upheldCount` is a SUBSET of `resolvedCount` (not a third
 *     disjoint bucket — see the design's "Computation & representation"); it is
 *     omitted entirely when `upheldCount === 0`, and the "revertidas" clause is
 *     omitted when `revertedCount === 0`.
 *   - "Sin historial aún" when the reliability sentinel is `null` (a freshly
 *     verified solver — never "0%"/"NaN").
 *
 * The reliability rate comes from the C2 `reliability` helper — the SINGLE place
 * the formula + rounding live, so the UI and tests measure the same thing.
 *
 * The visual idiom mirrors `corroborated-badge` (accent chip + quiet counts).
 */

import { reliability } from "@/lib/reputation/reliability";
import { plural } from "@/lib/text/plural";

type Props = {
  resolvedCount: number;
  upheldCount: number;
  revertedCount: number;
};

export default function ReputationBlock({
  resolvedCount,
  upheldCount,
  revertedCount,
}: Props) {
  const rate = reliability(resolvedCount, revertedCount);

  // Freshly verified solver (no resolutions and no reversions) → no rate, no
  // counts worth showing. The sentinel renders the empty state, never "0%".
  if (rate === null) {
    return (
      <div className="solver-reputation">
        <span className="solver-reputation__empty">Sin historial aún</span>
      </div>
    );
  }

  const resolvedText = `${resolvedCount} ${plural(
    resolvedCount,
    "resuelto",
    "resueltos",
  )}`;
  // `upheld` is a SUBSET of `resolved`: the parenthetical signals "of these, M
  // survived a dispute", not an additive tally. Omitted when none.
  const upheldText =
    upheldCount === 0
      ? ""
      : ` (${upheldCount} ${plural(
          upheldCount,
          "sostenida",
          "sostenidas",
        )} en disputa)`;
  const revertedText =
    revertedCount === 0
      ? ""
      : ` · ${revertedCount} ${plural(
          revertedCount,
          "revertida",
          "revertidas",
        )}`;

  return (
    <div className="solver-reputation">
      <span className="solver-reputation__rate">{rate}% fiable</span>
      <span className="solver-reputation__counts">
        {resolvedText}
        {upheldText}
        {revertedText}
      </span>
    </div>
  );
}
