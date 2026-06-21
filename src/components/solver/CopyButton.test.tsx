// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CopyButton from "./CopyButton";

/**
 * CopyButton tests (subsystem D, chunk D3 — the copy half of SCEN-009).
 *
 * `navigator.clipboard.writeText` is mocked so the test pins the copied value
 * and the "Copiado ✓" feedback without a real clipboard.
 */

/** jsdom exposes `navigator.clipboard` as a getter-only prop → define it. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("CopyButton", () => {
  it("copies the value and shows 'Copiado ✓' via role=status", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);

    render(<CopyButton value="3001234567" />);

    // fireEvent (not userEvent) so userEvent's own clipboard stub does not
    // shadow ours — we assert OUR writeText receives the exact value.
    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));

    const status = await screen.findByRole("status");
    expect(status.textContent ?? "").toMatch(/Copiado/);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("3001234567");
  });

  it("shows an error (role=alert) when the clipboard write fails", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    stubClipboard(writeText);

    render(<CopyButton value="x" />);

    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/No se pudo copiar/);
  });
});
