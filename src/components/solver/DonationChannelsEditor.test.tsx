// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DonationChannelsEditor from "./DonationChannelsEditor";
import type { DonationChannel } from "@/lib/services/solverService";

/**
 * DonationChannelsEditor tests (subsystem D, chunk D3 — SCEN-011, UI half of
 * SCEN-012). `fetch` and `next/navigation`'s router are mocked so the test pins
 * the EXACT save/upload/delete contract without a network:
 *   - a plain save POSTs to the channels route;
 *   - a rail WITH a chosen file uploads to donation-qr FIRST, then saves with the
 *     returned qrPath;
 *   - delete calls DELETE with `{ type }`;
 *   - an error response renders an alert.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

beforeEach(() => {
  refresh.mockClear();
  // jsdom lacks the object-URL APIs the file preview uses.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const NO_CHANNELS: DonationChannel[] = [];

/** Find the row whose type pill matches `label` (Nequi/Bancolombia/…). */
function rowFor(label: string): HTMLElement {
  const pill = screen.getByText(label, { selector: ".donation-editor__type" });
  return pill.closest("li") as HTMLElement;
}

describe("DonationChannelsEditor", () => {
  it("renders one row per donation type", () => {
    render(<DonationChannelsEditor initialChannels={NO_CHANNELS} />);
    expect(rowFor("Nequi")).toBeTruthy();
    expect(rowFor("Daviplata")).toBeTruthy();
    expect(rowFor("Bancolombia")).toBeTruthy();
    expect(rowFor("PayPal")).toBeTruthy();
  });

  it("saves a Nequi channel by POSTing to the channels route (no file → no upload)", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ channel: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DonationChannelsEditor initialChannels={NO_CHANNELS} />);
    const row = rowFor("Nequi");

    await user.type(within(row).getByRole("textbox"), "3001234567");
    await user.click(within(row).getByRole("button", { name: "Guardar" }));

    // No file → exactly ONE fetch: the channels save.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/solver/donation-channels");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      type: "nequi",
      value: "3001234567",
    });

    expect(await within(row).findByRole("status")).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("uploads the QR FIRST then saves with the returned qrPath when a file is chosen", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = args[0] as string;
      if (url === "/api/solver/donation-qr") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ qrPath: "donation-qr/u/nequi.png" }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ channel: {} }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DonationChannelsEditor initialChannels={NO_CHANNELS} />);
    const row = rowFor("Nequi");

    await user.type(within(row).getByRole("textbox"), "3001234567");
    const file = new File(["bytes"], "qr.png", { type: "image/png" });
    await user.upload(
      within(row).getByLabelText("Código QR (imagen)"),
      file,
    );
    await user.click(within(row).getByRole("button", { name: "Guardar" }));

    // Two calls IN ORDER: upload, then save.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/solver/donation-qr");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/solver/donation-channels");

    // The upload is multipart with the file + type.
    const uploadInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    const form = uploadInit.body as FormData;
    expect(form.get("type")).toBe("nequi");
    expect(form.get("file")).toBeInstanceOf(File);

    // The save carries the qrPath the upload returned.
    const saveInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(saveInit.body as string)).toEqual({
      type: "nequi",
      value: "3001234567",
      qrPath: "donation-qr/u/nequi.png",
    });
  });

  it("saves a Bancolombia channel with the chosen account kind", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ channel: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DonationChannelsEditor initialChannels={NO_CHANNELS} />);
    const row = rowFor("Bancolombia");

    await user.type(within(row).getByRole("textbox"), "12345678901");
    await user.selectOptions(
      within(row).getByRole("combobox"),
      "corriente",
    );
    await user.click(within(row).getByRole("button", { name: "Guardar" }));

    const saveInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(saveInit.body as string)).toEqual({
      type: "bancolombia",
      value: "12345678901",
      accountKind: "corriente",
    });
  });

  it("deletes an existing channel by sending DELETE { type }", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const existing: DonationChannel[] = [
      { type: "nequi", value: "3001234567", accountKind: null, qrUrl: null },
    ];
    render(<DonationChannelsEditor initialChannels={existing} />);
    const row = rowFor("Nequi");

    // The delete button only exists because the channel exists.
    await user.click(within(row).getByRole("button", { name: "Eliminar" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/solver/donation-channels");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      type: "nequi",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("has no Delete button for a type with no existing channel", () => {
    render(<DonationChannelsEditor initialChannels={NO_CHANNELS} />);
    const row = rowFor("Daviplata");
    expect(within(row).queryByRole("button", { name: "Eliminar" })).toBeNull();
  });

  it("renders the server error message on a non-ok save (role=alert)", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: false,
      status: 422,
      json: async () => ({
        error: { message: "El número celular debe tener 10 dígitos y empezar por 3." },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DonationChannelsEditor initialChannels={NO_CHANNELS} />);
    const row = rowFor("Nequi");

    await user.type(within(row).getByRole("textbox"), "123");
    await user.click(within(row).getByRole("button", { name: "Guardar" }));

    const alert = await within(row).findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/10 dígitos/);
    expect(refresh).not.toHaveBeenCalled();
  });
});
