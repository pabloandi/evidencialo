"use client";

/**
 * Reusable Cloudflare Turnstile widget (extracted from `CaptureForm`'s captcha
 * effect so other anonymous write paths — e.g. filing a dispute — reuse the SAME
 * render/cleanup contract instead of re-implementing it).
 *
 * Behavior, mirroring CaptureForm:
 *   - Reads `NEXT_PUBLIC_TURNSTILE_SITE_KEY` at MODULE LOAD. With NO key the
 *     widget renders nothing (`return null`) — the caller's anonymous flow is
 *     then captcha-exempt, exactly like the form's `!TURNSTILE_SITE_KEY` branch.
 *   - On mount it loads/renders the widget with `render=explicit`, REUSING an
 *     existing `api.js` script tag instead of appending a duplicate.
 *   - On every solved challenge it calls `onToken(token)`.
 *   - On teardown it `window.turnstile.remove(widgetId)` inside try/catch so a
 *     Turnstile-internal throw never breaks React unmount, and Cloudflare does
 *     not leak the widget / log "Cannot find Widget …".
 */

import { useEffect, useRef } from "react";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: { sitekey: string; callback: (token: string) => void },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

type Props = {
  onToken: (token: string) => void;
  className?: string;
};

export default function TurnstileWidget({ onToken, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest callback in a ref so the lifecycle effect (which must run
  // ONCE and own the widget) never re-renders/re-creates the widget when the
  // caller passes a fresh inline `onToken`. Synced in its own effect — writing a
  // ref during render is disallowed (react-hooks/refs).
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    const container = containerRef.current;
    if (!container) return;

    let widgetId: string | undefined;

    function renderWidget() {
      if (window.turnstile && container && container.childElementCount === 0) {
        widgetId = window.turnstile.render(container, {
          sitekey: TURNSTILE_SITE_KEY!,
          callback: (token: string) => onTokenRef.current(token),
        });
      }
    }

    if (window.turnstile) {
      renderWidget();
    } else {
      // Reuse an existing api.js tag instead of appending a duplicate.
      const existing = document.querySelector<HTMLScriptElement>(
        'script[src*="turnstile/v0/api.js"]',
      );
      if (existing) {
        existing.addEventListener("load", renderWidget);
      } else {
        const script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.onload = renderWidget;
        document.head.appendChild(script);
      }
    }

    return () => {
      // Defensive: a Turnstile-internal throw must never break React teardown.
      if (widgetId && window.turnstile?.remove) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // ignore — widget already gone / Turnstile internal error.
        }
      }
    };
  }, []);

  // No site key configured → render nothing; the caller's flow is captcha-exempt.
  if (!TURNSTILE_SITE_KEY) return null;

  return <div ref={containerRef} className={className} />;
}
