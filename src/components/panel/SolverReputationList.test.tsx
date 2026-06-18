// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import SolverReputationList from "./SolverReputationList";

/**
 * SolverReputationList unit tests (subsystem C, chunk C3) — SCEN-009.
 *
 * Pins the presentational contract: rows render in the GIVEN order (the page
 * sorts; the list does not), each row shows the handle link, the counts line
 * (same copy idiom as ReputationBlock), and the reliability chip or the
 * "Sin historial aún" sentinel per row.
 */

afterEach(cleanup);

describe("SolverReputationList", () => {
  it("renders rows in the given order with handle link, counts, and rate chip", () => {
    render(
      <SolverReputationList
        rows={[
          {
            handle: "alta",
            resolvedCount: 47,
            upheldCount: 3,
            revertedCount: 2,
            reliability: 96,
          },
          {
            handle: "baja",
            resolvedCount: 1,
            upheldCount: 0,
            revertedCount: 5,
            reliability: 17,
          },
        ]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);

    // Given order is preserved (the page is the sorter, not the list).
    expect(within(items[0]).getByText("@alta")).not.toBeNull();
    expect(within(items[1]).getByText("@baja")).not.toBeNull();

    // Handle link → public profile.
    const link = within(items[0]).getByText("@alta") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/solucionadores/alta");

    // Rate chip + counts copy idiom.
    expect(within(items[0]).getByText("96% fiable")).not.toBeNull();
    expect(
      within(items[0]).getByText(
        "47 resueltos (3 sostenidas en disputa) · 2 revertidas",
      ),
    ).not.toBeNull();

    expect(within(items[1]).getByText("17% fiable")).not.toBeNull();
    expect(
      within(items[1]).getByText("1 resuelto · 5 revertidas"),
    ).not.toBeNull();
  });

  it("renders the 'Sin historial aún' sentinel for a null-reliability row", () => {
    render(
      <SolverReputationList
        rows={[
          {
            handle: "nuevo",
            resolvedCount: 0,
            upheldCount: 0,
            revertedCount: 0,
            reliability: null,
          },
        ]}
      />,
    );

    const item = screen.getByRole("listitem");
    expect(within(item).getByText("Sin historial aún")).not.toBeNull();
    expect(within(item).queryByText(/fiable/)).toBeNull();
    expect(within(item).getByText("0 resueltos")).not.toBeNull();
  });
});
