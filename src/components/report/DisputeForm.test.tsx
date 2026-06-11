// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DisputeForm from "./DisputeForm";

/**
 * DisputeForm unit tests (subsystem B, chunk B3.2 — SCEN-007).
 *
 * `fetch` is mocked so the test pins the EXACT dispute write contract
 * (URL + `{ reason }` body) without a network. The `TurnstileWidget` is mocked
 * to a no-op so these tests stay focused on the form's submit/success/error
 * behavior (its own render/cleanup lifecycle is covered by CaptureForm's
 * turnstile test, which shares the extracted effect).
 */

vi.mock("@/components/captcha/TurnstileWidget", () => ({
  default: () => <div data-testid="turnstile" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DisputeForm", () => {
  it("expands, submits the reason to the dispute URL, and shows success on 201", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 201,
      json: async () => ({ id: "dis-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DisputeForm reportId="rep-1" anonymous={false} />);

    // Collapsed by default: the textarea is hidden behind the toggle.
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Reportar resolución falsa" }),
    );

    await user.type(
      screen.getByRole("textbox"),
      "El bache sigue ahí",
    );
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/rep-1/dispute");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      reason: "El bache sigue ahí",
    });

    // Success state replaces the form.
    const status = await screen.findByRole("status");
    expect(status.textContent ?? "").toMatch(
      /Un administrador revisará este reporte/i,
    );
    expect(
      screen.queryByRole("button", { name: "Enviar reporte" }),
    ).toBeNull();
  });

  it("does NOT send a captcha header for a logged-in (non-anonymous) caller", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 201,
      json: async () => ({ id: "dis-1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DisputeForm reportId="rep-9" anonymous={false} />);

    await user.click(
      screen.getByRole("button", { name: "Reportar resolución falsa" }),
    );
    // A logged-in caller never gets the Turnstile widget.
    expect(screen.queryByTestId("turnstile")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["cf-turnstile-response"]).toBeUndefined();
    // Empty optional reason still posts (the server stores NULL).
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      reason: "",
    });
  });

  it("shows the server error message on a 409 (open dispute already exists)", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: { message: "Ya hay una disputa abierta para este reporte." },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DisputeForm reportId="rep-2" anonymous={false} />);

    await user.click(
      screen.getByRole("button", { name: "Reportar resolución falsa" }),
    );
    await user.click(screen.getByRole("button", { name: "Enviar reporte" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/Ya hay una disputa abierta/i);
    // The form stays mounted (no success) so the user can read the message.
    expect(
      screen.getByRole("button", { name: "Enviar reporte" }),
    ).not.toBeNull();
  });
});
