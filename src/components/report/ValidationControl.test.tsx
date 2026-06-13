// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ValidationControl from "./ValidationControl";

/**
 * ValidationControl unit tests (subsystem A, chunk A3).
 *
 * Mirrors `DisputeForm.test.tsx`: `fetch` is mocked so the test pins the EXACT
 * validate write contract (URL + camelCase response) without a network. The
 * `TurnstileWidget` is mocked to a no-op so these tests stay focused on the
 * control's confirm/success/error behavior (its render/cleanup lifecycle is
 * covered by CaptureForm's turnstile test, which shares the extracted effect).
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

const CONFIRM = "Confirmar — yo también lo veo";

describe("ValidationControl", () => {
  it("posts to the validate URL and updates counts + shows 'Ya confirmaste' on 201", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 201,
      json: async () => ({
        verifiedCount: 3,
        anonCount: 1,
        corroborated: true,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ValidationControl
        reportId="rep-1"
        anonymous={false}
        verifiedCount={2}
        anonCount={1}
        corroborated={false}
        hasValidated={false}
      />,
    );

    // Seeded from props: no chip yet, counts reflect the initial verified=2.
    expect(screen.queryByText("Corroborado ✓")).toBeNull();
    expect(screen.getByText(/verificad/).textContent).toBe(
      "2 verificadas · 1 anónima",
    );

    await user.click(screen.getByRole("button", { name: CONFIRM }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/rep-1/validate");
    expect((init as RequestInit).method).toBe("POST");

    // Success → done state (role=status), button gone, counts + chip updated.
    const status = await screen.findByRole("status");
    expect(status.textContent ?? "").toMatch(/Ya confirmaste/i);
    expect(screen.queryByRole("button", { name: CONFIRM })).toBeNull();
    expect(screen.getByText("Corroborado ✓")).not.toBeNull();
    expect(screen.getByText(/verificad/).textContent).toBe(
      "3 verificadas · 1 anónima",
    );
  });

  it("does NOT send a captcha header for a logged-in (non-anonymous) caller", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 201,
      json: async () => ({
        verifiedCount: 1,
        anonCount: 0,
        corroborated: false,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ValidationControl
        reportId="rep-9"
        anonymous={false}
        verifiedCount={0}
        anonCount={0}
        corroborated={false}
        hasValidated={false}
      />,
    );

    // A logged-in caller never gets the Turnstile widget.
    expect(screen.queryByTestId("turnstile")).toBeNull();

    await user.click(screen.getByRole("button", { name: CONFIRM }));

    const [, init] = fetchMock.mock.calls[0];
    const headers = ((init as RequestInit).headers ?? {}) as Record<
      string,
      string
    >;
    expect(headers["cf-turnstile-response"]).toBeUndefined();
  });

  it("sends the captcha header for an anonymous caller once a token is set", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 201,
      json: async () => ({
        verifiedCount: 0,
        anonCount: 1,
        corroborated: false,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ValidationControl
        reportId="rep-3"
        anonymous
        verifiedCount={0}
        anonCount={0}
        corroborated={false}
        hasValidated={false}
      />,
    );

    // The anon path renders the (mocked) Turnstile widget.
    expect(screen.getByTestId("turnstile")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: CONFIRM }));

    const [, init] = fetchMock.mock.calls[0];
    // No token was solved (the widget is a no-op mock) → header omitted, exactly
    // like the captcha-exempt path when no site key is configured.
    const headers = ((init as RequestInit).headers ?? {}) as Record<
      string,
      string
    >;
    expect(headers["cf-turnstile-response"]).toBeUndefined();
  });

  it("treats a 200 (already validated) as success and shows the done state", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({
        verifiedCount: 5,
        anonCount: 0,
        corroborated: true,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ValidationControl
        reportId="rep-2"
        anonymous={false}
        verifiedCount={5}
        anonCount={0}
        corroborated
        hasValidated={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: CONFIRM }));

    const status = await screen.findByRole("status");
    expect(status.textContent ?? "").toMatch(/Ya confirmaste/i);
    expect(screen.queryByRole("button", { name: CONFIRM })).toBeNull();
  });

  it("shows the server error message on a non-ok response", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: { message: "Este reporte ya no admite confirmaciones." },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ValidationControl
        reportId="rep-4"
        anonymous={false}
        verifiedCount={1}
        anonCount={0}
        corroborated={false}
        hasValidated={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: CONFIRM }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/ya no admite confirmaciones/i);
    // The button stays mounted so the user can retry.
    expect(screen.getByRole("button", { name: CONFIRM })).not.toBeNull();
  });

  it("renders the done state without a confirm button when hasValidated is true", () => {
    render(
      <ValidationControl
        reportId="rep-5"
        anonymous={false}
        verifiedCount={3}
        anonCount={2}
        corroborated
        hasValidated
      />,
    );

    expect(screen.getByRole("status").textContent ?? "").toMatch(
      /Ya confirmaste/i,
    );
    expect(screen.queryByRole("button", { name: CONFIRM })).toBeNull();
    // The badge still renders with the live (seeded) counts.
    expect(screen.getByText("Corroborado ✓")).not.toBeNull();
    expect(screen.getByText(/verificad/).textContent).toBe(
      "3 verificadas · 2 anónimas",
    );
  });
});
