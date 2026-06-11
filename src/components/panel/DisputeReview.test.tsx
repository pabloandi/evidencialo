// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DisputeReview from "./DisputeReview";

/**
 * DisputeReview unit tests (subsystem B, chunk B3.2 — SCEN-007).
 *
 * `fetch` and `next/navigation`'s router are mocked so the test pins the EXACT
 * resolve contract (`{ action }` body + URL) and the `router.refresh()` on
 * success — without a network or a real router.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DisputeReview", () => {
  it("renders the reason and the placeholder when none", () => {
    vi.stubGlobal("fetch", vi.fn());

    const { rerender } = render(
      <DisputeReview disputeId="dis-1" reportId="rep-1" reason="No arreglado" />,
    );
    expect(screen.getByText("No arreglado")).not.toBeNull();

    rerender(
      <DisputeReview disputeId="dis-1" reportId="rep-1" reason={null} />,
    );
    expect(screen.getByText("— sin motivo —")).not.toBeNull();
  });

  it("POSTs { action: 'revert' } and refreshes on ok", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "reverted" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <DisputeReview disputeId="dis-2" reportId="rep-2" reason="abuso" />,
    );

    await user.click(
      screen.getByRole("button", { name: "Revertir a en proceso" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/disputes/dis-2/resolve");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      action: "revert",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("POSTs { action: 'uphold' } and refreshes on ok", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "upheld" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <DisputeReview disputeId="dis-3" reportId="rep-3" reason={null} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Mantener resolución" }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/disputes/dis-3/resolve");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      action: "uphold",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows a Spanish error and does NOT refresh on failure", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "No autorizado." } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <DisputeReview disputeId="dis-4" reportId="rep-4" reason="x" />,
    );

    await user.click(
      screen.getByRole("button", { name: "Mantener resolución" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/No autorizado/i);
    expect(refresh).not.toHaveBeenCalled();
  });
});
