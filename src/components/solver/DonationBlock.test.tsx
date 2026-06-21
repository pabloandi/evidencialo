// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DonationBlock from "./DonationBlock";
import type { DonationChannel } from "@/lib/services/solverService";

/**
 * DonationBlock tests (subsystem D, chunk D3 — SCEN-009, UI half of 007/008).
 *
 * The block is an ASYNC server component: it `await`s `paypalQrSvg`. We test it
 * by awaiting the component (resolving its element) and rendering the result —
 * the same way an RSC tree would. `paypalQrSvg` is mocked to a deterministic SVG
 * so the test is fast and does not depend on the QR lib output.
 *
 * `CopyButton` is mocked to a marker so we assert one copy affordance per
 * Colombian rail without exercising the clipboard (its own behavior is covered
 * in CopyButton.test.tsx).
 */

vi.mock("@/lib/donation/paypalQr", () => ({
  paypalQrSvg: vi.fn(async (url: string) => `<svg data-url="${url}"></svg>`),
}));

vi.mock("@/components/solver/CopyButton", () => ({
  default: ({ value }: { value: string }) => (
    <button data-testid="copy" data-value={value}>
      Copiar
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Await the async server component to its element, then render it. */
async function renderBlock(channels: DonationChannel[]) {
  const element = await DonationBlock({ channels });
  return render(element);
}

describe("DonationBlock", () => {
  it("renders nothing when the solver has zero channels (SCEN-009 empty state)", async () => {
    const element = await DonationBlock({ channels: [] });
    expect(element).toBeNull();
  });

  it("renders a card + a copy affordance per Colombian rail", async () => {
    const channels: DonationChannel[] = [
      { type: "nequi", value: "3001234567", accountKind: null, qrUrl: null },
      {
        type: "bancolombia",
        value: "12345678901",
        accountKind: "ahorros",
        qrUrl: "https://cdn.example/donation-qr/u/bancolombia.png",
      },
    ];

    await renderBlock(channels);

    // Heading present.
    expect(
      screen.getByRole("heading", { name: "Apóyalo" }),
    ).toBeTruthy();

    // One copy button per rail, each carrying the exact value to copy.
    const copies = screen.getAllByTestId("copy");
    expect(copies).toHaveLength(2);
    expect(copies.map((c) => c.getAttribute("data-value"))).toEqual([
      "3001234567",
      "12345678901",
    ]);

    // The values + the bancolombia account kind render.
    expect(screen.getByText("3001234567")).toBeTruthy();
    expect(screen.getByText("12345678901")).toBeTruthy();
    expect(screen.getByText("Ahorros")).toBeTruthy();
  });

  it("renders an <img alt> QR for a rail that has a qrUrl", async () => {
    const channels: DonationChannel[] = [
      {
        type: "nequi",
        value: "3001234567",
        accountKind: null,
        qrUrl: "https://cdn.example/donation-qr/u/nequi.png",
      },
    ];

    await renderBlock(channels);

    const img = screen.getByAltText(
      "Código QR para donar por Nequi",
    ) as HTMLImageElement;
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe(
      "https://cdn.example/donation-qr/u/nequi.png",
    );
  });

  it("does NOT render a QR image for a rail without a qrUrl", async () => {
    const channels: DonationChannel[] = [
      { type: "nequi", value: "3001234567", accountKind: null, qrUrl: null },
    ];

    await renderBlock(channels);

    expect(screen.queryByRole("img")).toBeNull();
    // The copy value is still shown.
    expect(screen.getByText("3001234567")).toBeTruthy();
  });

  it("renders the generated SVG + an 'Abrir PayPal' link for a PayPal channel (SCEN-008)", async () => {
    const { paypalQrSvg } = await import("@/lib/donation/paypalQr");
    const channels: DonationChannel[] = [
      {
        type: "paypal",
        value: "https://paypal.me/maria",
        accountKind: null,
        qrUrl: null,
      },
    ];

    const { container } = await renderBlock(channels);

    // The util was asked to encode the exact normalized URL.
    expect(paypalQrSvg).toHaveBeenCalledWith("https://paypal.me/maria");

    // The generated SVG is inlined.
    const svg = container.querySelector(".donation-channel__qr--svg svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("data-url")).toBe("https://paypal.me/maria");

    // The SVG wrapper is an accessible image with a Spanish label (a11y).
    const qrWrap = container.querySelector(".donation-channel__qr--svg")!;
    expect(qrWrap.getAttribute("role")).toBe("img");
    expect(qrWrap.getAttribute("aria-label")).toBe(
      "Código QR para donar por PayPal",
    );

    // "Abrir PayPal" link points at the normalized URL, opens safely.
    const link = screen.getByRole("link", {
      name: "Abrir PayPal",
    }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://paypal.me/maria");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    // PayPal never shows a copy affordance.
    expect(screen.queryByTestId("copy")).toBeNull();
  });

  it("drops a single card that fails to render instead of crashing the whole block (resilience)", async () => {
    const { paypalQrSvg } = await import("@/lib/donation/paypalQr");
    // Simulate a render failure for the PayPal card (e.g. an unexpected throw).
    vi.mocked(paypalQrSvg).mockRejectedValueOnce(new Error("boom"));

    const channels: DonationChannel[] = [
      { type: "nequi", value: "3001234567", accountKind: null, qrUrl: null },
      {
        type: "paypal",
        value: "https://paypal.me/maria",
        accountKind: null,
        qrUrl: null,
      },
    ];

    // Must NOT throw — Promise.all would otherwise reject the whole page.
    await renderBlock(channels);

    // The good rail still renders; the failing PayPal card is dropped.
    expect(screen.getByText("3001234567")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Abrir PayPal" })).toBeNull();
  });
});
