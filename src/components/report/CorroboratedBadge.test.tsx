// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import CorroboratedBadge from "./CorroboratedBadge";

/**
 * CorroboratedBadge unit tests (subsystem A, chunk A3).
 *
 * Pins the presentational contract: the "Corroborado ✓" chip appears ONLY when
 * `corroborated` is true, and the counts line is singular/plural-aware with the
 * "anónima(s)" clause omitted entirely when `anonCount === 0`.
 */

afterEach(cleanup);

describe("CorroboratedBadge", () => {
  it("shows the 'Corroborado ✓' chip only when corroborated", () => {
    const { rerender } = render(
      <CorroboratedBadge verifiedCount={3} anonCount={0} corroborated />,
    );
    expect(screen.getByText("Corroborado ✓")).not.toBeNull();

    rerender(
      <CorroboratedBadge
        verifiedCount={2}
        anonCount={0}
        corroborated={false}
      />,
    );
    expect(screen.queryByText("Corroborado ✓")).toBeNull();
  });

  it("renders singular counts and omits the anon clause when anonCount is 0", () => {
    render(
      <CorroboratedBadge
        verifiedCount={1}
        anonCount={0}
        corroborated={false}
      />,
    );
    const counts = screen.getByText(/verificada/);
    expect(counts.textContent).toBe("1 verificada");
    expect(counts.textContent).not.toContain("anónima");
  });

  it("pluralizes verified and includes a pluralized anon clause", () => {
    render(
      <CorroboratedBadge verifiedCount={4} anonCount={2} corroborated />,
    );
    const counts = screen.getByText(/verificadas/);
    expect(counts.textContent).toBe("4 verificadas · 2 anónimas");
  });

  it("uses the singular anon form for exactly one anonymous confirmation", () => {
    render(
      <CorroboratedBadge
        verifiedCount={2}
        anonCount={1}
        corroborated={false}
      />,
    );
    const counts = screen.getByText(/verificadas/);
    expect(counts.textContent).toBe("2 verificadas · 1 anónima");
  });
});
