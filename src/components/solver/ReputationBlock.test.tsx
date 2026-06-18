// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import ReputationBlock from "./ReputationBlock";

/**
 * ReputationBlock unit tests (subsystem C, chunk C3) — SCEN-007.
 *
 * Pins the presentational contract: the accent "X% fiable" chip from the C2
 * `reliability` helper, the singular/plural-aware counts line, the upheld
 * parenthetical (a SUBSET of resolved) omitted when 0, the reverted clause
 * omitted when 0, and the "Sin historial aún" sentinel for a freshly verified
 * solver (never "0%").
 */

afterEach(cleanup);

describe("ReputationBlock", () => {
  it("renders the rate chip and full counts line for (47, 3, 2)", () => {
    render(
      <ReputationBlock resolvedCount={47} upheldCount={3} revertedCount={2} />,
    );
    // 47/(47+2) = 95.9% → round-half-up → 96%.
    expect(screen.getByText("96% fiable")).not.toBeNull();
    const counts = screen.getByText(/resueltos/);
    expect(counts.textContent).toBe(
      "47 resueltos (3 sostenidas en disputa) · 2 revertidas",
    );
  });

  it("renders 'Sin historial aún' for (0, 0, 0) and no rate chip", () => {
    render(
      <ReputationBlock resolvedCount={0} upheldCount={0} revertedCount={0} />,
    );
    expect(screen.getByText("Sin historial aún")).not.toBeNull();
    expect(screen.queryByText(/fiable/)).toBeNull();
  });

  it("omits the upheld parenthetical when upheldCount is 0", () => {
    render(
      <ReputationBlock resolvedCount={10} upheldCount={0} revertedCount={2} />,
    );
    const counts = screen.getByText(/resueltos/);
    expect(counts.textContent).toBe("10 resueltos · 2 revertidas");
    expect(counts.textContent).not.toContain("disputa");
  });

  it("omits the reverted clause when revertedCount is 0 (→ 100% fiable)", () => {
    render(
      <ReputationBlock resolvedCount={5} upheldCount={2} revertedCount={0} />,
    );
    expect(screen.getByText("100% fiable")).not.toBeNull();
    const counts = screen.getByText(/resueltos/);
    expect(counts.textContent).toBe("5 resueltos (2 sostenidas en disputa)");
    expect(counts.textContent).not.toContain("revertida");
  });

  it("uses singular forms for counts of exactly one", () => {
    render(
      <ReputationBlock resolvedCount={1} upheldCount={1} revertedCount={1} />,
    );
    const counts = screen.getByText(/resuelto/);
    expect(counts.textContent).toBe(
      "1 resuelto (1 sostenida en disputa) · 1 revertida",
    );
  });
});
