"use client";

/**
 * Copy-to-clipboard affordance for a donation channel's cell/account number
 * (subsystem D, chunk D3; the copy half of SCEN-009). There is no existing
 * clipboard pattern in the codebase — this is the fresh one.
 *
 * Clicking copies `value` via `navigator.clipboard.writeText`, then flips the
 * label to "Copiado ✓" (announced via `role="status"`) for ~2s before reverting.
 * If the clipboard write fails (permission/unsupported), it shows a short error
 * (`role="alert"`) instead of silently doing nothing.
 *
 * Styled with `.donation-channel__copy` (mirrors `.capture-btn--secondary` — an
 * accent-outline pill).
 */

import { useEffect, useRef, useState } from "react";

type Props = {
  /** The exact string copied to the clipboard (the cell/account number). */
  value: string;
  /** Accessible label override; defaults to "Copiar". */
  label?: string;
};

const RESET_MS = 2000;

export default function CopyButton({ value, label = "Copiar" }: Props) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending reset timer on unmount (no setState-after-unmount).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function onCopy() {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("error");
    }
    timerRef.current = setTimeout(() => setState("idle"), RESET_MS);
  }

  if (state === "error") {
    return (
      <button
        type="button"
        className="capture-btn capture-btn--secondary donation-channel__copy"
        onClick={onCopy}
      >
        <span role="alert">No se pudo copiar</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="capture-btn capture-btn--secondary donation-channel__copy"
      onClick={onCopy}
      aria-label={state === "copied" ? "Copiado" : label}
    >
      {state === "copied" ? <span role="status">Copiado ✓</span> : label}
    </button>
  );
}
