// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CaptureForm Turnstile lifecycle (SCEN-006 cleanup + SCEN-007 no script dupe).
 *
 * The anonymous captcha path is what leaks: `CaptureForm` reads
 * `TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY` at MODULE
 * LOAD, so the sitekey must be stubbed BEFORE a dynamic `import("./CaptureForm")`
 * — hence this sibling file (the main test imports the module statically with no
 * sitekey, exercising the captcha-exempt path). A fake `window.turnstile`
 * records `render`/`remove` so we can pin the cleanup contract.
 */

const getSession = vi.fn();
const categoriesSelect = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/lib/supabase/browser", () => ({
  createBrowserSupabase: () => ({
    auth: { getSession },
    from: () => ({
      select: () => ({ order: categoriesSelect }),
    }),
    storage: {
      from: () => ({ uploadToSignedUrl: vi.fn() }),
    },
  }),
}));

// Anonymous: no session → captcha required (with a sitekey configured).
function anonymousSession() {
  getSession.mockResolvedValue({ data: { session: null } });
}

beforeEach(() => {
  anonymousSession();
  categoriesSelect.mockResolvedValue({
    data: [{ slug: "bache", name: "Bache" }],
  });
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (window as { turnstile?: unknown }).turnstile;
  document
    .querySelectorAll('script[src*="turnstile/v0/api.js"]')
    .forEach((s) => s.remove());
});

/** Stub the sitekey, then import the module so its module-load const sees it. */
async function importForm() {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-sitekey");
  return (await import("./CaptureForm")).default;
}

/** Flush the async getSession resolution + the effect that renders the widget. */
async function flush() {
  // microtasks (getSession promise) + a render tick.
  await vi.waitFor(() => {
    expect(window.turnstile?.render).toHaveBeenCalled();
  });
}

describe("SCEN-006: the Turnstile widget is cleaned up on unmount", () => {
  it("renders the widget once and removes it (by id) on unmount", async () => {
    const renderWidget = vi.fn(() => "widget-id-1");
    const removeWidget = vi.fn();
    (window as { turnstile?: unknown }).turnstile = {
      render: renderWidget,
      remove: removeWidget,
    };

    const CaptureForm = await importForm();
    const { unmount } = render(<CaptureForm />);

    await flush();
    expect(renderWidget).toHaveBeenCalledTimes(1);

    unmount();

    expect(removeWidget).toHaveBeenCalledTimes(1);
    expect(removeWidget).toHaveBeenCalledWith("widget-id-1");
  });
});

describe("SCEN-007: the api.js script tag is not duplicated on re-render", () => {
  it("reuses the existing api.js script instead of appending a second", async () => {
    // No window.turnstile yet → each effect run wants to inject the api.js
    // script. Two anonymous forms each run the effect with the global still
    // undefined: the unfixed code appends one tag per run (→ 2), the fixed
    // code dedupes against the existing tag (→ 1).
    const CaptureForm = await importForm();

    const first = render(<CaptureForm />);
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll('script[src*="turnstile/v0/api.js"]').length,
      ).toBe(1);
    });

    const second = render(<CaptureForm />);
    // Both forms have rendered their Turnstile container — the captcha label
    // appears once per anonymous form, which only happens AFTER each form's
    // getSession resolves and its widget effect has run. Waiting on this DOM
    // signal guarantees the second effect had its chance to (wrongly) append a
    // second api.js tag before we assert the dedupe held.
    await vi.waitFor(() => {
      expect(screen.getAllByText("Verificación")).toHaveLength(2);
    });

    expect(
      document.querySelectorAll('script[src*="turnstile/v0/api.js"]').length,
    ).toBe(1);

    first.unmount();
    second.unmount();
  });
});
