// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ResolutionControls from "./ResolutionControls";

/**
 * ResolutionControls unit tests (solver-resolution SCEN-001/002/003).
 *
 * `fetch` and `next/navigation`'s router are mocked so the test asserts the
 * EXACT status-write contract + refresh behavior without a network or a real
 * router. `ResolutionUpload` is mocked to keep this focused on the control bar
 * (its own upload chain is covered in ResolutionUpload.test.tsx).
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("./ResolutionUpload", () => ({
  default: ({ onUploaded }: { onUploaded: () => void }) => (
    <div data-testid="resolution-upload">
      <button type="button" onClick={onUploaded}>
        mock-uploaded
      </button>
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("status === 'nuevo'", () => {
  it("renders Reclamar and POSTs status en_proceso then refreshes", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "en_proceso" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ResolutionControls
        reportId="rep-1"
        status="nuevo"
        hasProcessedProof={false}
      />,
    );

    // No resolve action in `nuevo`.
    expect(
      screen.queryByRole("button", { name: /Marcar como resuelto/ }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reclamar" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/rep-1/status");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      status: "en_proceso",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("status === 'en_proceso'", () => {
  it("renders the upload toggle and a resolve button (disabled without proof)", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(
      <ResolutionControls
        reportId="rep-1"
        status="en_proceso"
        hasProcessedProof={false}
      />,
    );

    const resolve = screen.getByRole("button", {
      name: "Marcar como resuelto",
    }) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);

    // The upload panel toggles open.
    expect(screen.queryByTestId("resolution-upload")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Subir evidencia" }));
    expect(screen.getByTestId("resolution-upload")).not.toBeNull();
  });

  it("POSTs status resuelto and refreshes when proof is present", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "resuelto" }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ResolutionControls
        reportId="rep-2"
        status="en_proceso"
        hasProcessedProof
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Marcar como resuelto" }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reports/rep-2/status");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      status: "resuelto",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the proof_required message on a 422 and does NOT refresh", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({ error: { code: "proof_required" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ResolutionControls
        reportId="rep-3"
        status="en_proceso"
        hasProcessedProof
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Marcar como resuelto" }),
    );

    expect((await screen.findByRole("alert")).textContent ?? "").toMatch(
      /Adjunta evidencia procesada antes de resolver/i,
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("status === 'resuelto'", () => {
  it("renders no actions, only a confirmation", () => {
    vi.stubGlobal("fetch", vi.fn());

    render(
      <ResolutionControls
        reportId="rep-1"
        status="resuelto"
        hasProcessedProof
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent ?? "").toMatch(/resuelto/i);
  });
});
