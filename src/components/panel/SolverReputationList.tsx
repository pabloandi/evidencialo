/**
 * Admin "Solucionadores" list (subsystem C, chunk C3) — the presentational rows
 * of the `/panel` reputation signal (SCEN-009).
 *
 * Purely presentational (no hooks, no fetch). It receives an ALREADY-SORTED
 * array of rows (the page sorts by `reverted_count DESC`, then reliability
 * ascending in JS — the DB cannot sort by the derived rate) and renders them in
 * the given order. Each row shows the handle (a link to the public profile), a
 * counts line with the same copy idiom as `ReputationBlock`, and the reliability
 * chip — or "Sin historial aún" when the rate sentinel is `null`.
 *
 * Mirrors the `panel__disputes` markup family so the admin sections read as one.
 */

import Link from "next/link";

import { plural } from "@/lib/text/plural";

type SolverReputationRow = {
  handle: string;
  resolvedCount: number;
  upheldCount: number;
  revertedCount: number;
  /** Derived per-row by the page via the C2 helper; `null` = no history. */
  reliability: number | null;
};

type Props = {
  rows: SolverReputationRow[];
};

function countsText(
  resolvedCount: number,
  upheldCount: number,
  revertedCount: number,
): string {
  const resolved = `${resolvedCount} ${plural(
    resolvedCount,
    "resuelto",
    "resueltos",
  )}`;
  const upheld =
    upheldCount === 0
      ? ""
      : ` (${upheldCount} ${plural(
          upheldCount,
          "sostenida",
          "sostenidas",
        )} en disputa)`;
  const reverted =
    revertedCount === 0
      ? ""
      : ` · ${revertedCount} ${plural(
          revertedCount,
          "revertida",
          "revertidas",
        )}`;
  return `${resolved}${upheld}${reverted}`;
}

export default function SolverReputationList({ rows }: Props) {
  return (
    <ul className="panel__solvers-list">
      {rows.map((row) => (
        <li key={row.handle} className="panel-card panel__solvers-row">
          <div className="panel-card__head">
            <Link
              className="panel__solvers-handle"
              href={`/solucionadores/${row.handle}`}
            >
              @{row.handle}
            </Link>
            {row.reliability === null ? (
              <span className="panel__solvers-empty">Sin historial aún</span>
            ) : (
              <span className="panel__solvers-rate">
                {row.reliability}% fiable
              </span>
            )}
          </div>
          <p className="panel__solvers-counts">
            {countsText(row.resolvedCount, row.upheldCount, row.revertedCount)}
          </p>
        </li>
      ))}
    </ul>
  );
}
