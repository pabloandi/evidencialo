"use client";

/**
 * Admin dispute-review control (subsystem B, chunk B3.2 — SCEN-007). One per
 * open dispute in the panel's "Disputas abiertas" section. Mirrors
 * `StatusControl`: it POSTs an action to an authed route and, on success, calls
 * `router.refresh()` so the server-rendered list drops the now-resolved dispute.
 *
 * Two actions map to the `resolve_dispute` RPC the backend route fronts:
 *   - "Mantener resolución"  → `{ action: 'uphold' }` (the resolution stands).
 *   - "Revertir a en proceso" → `{ action: 'revert' }` (report → `en_proceso`,
 *     resolved attribution stripped).
 *
 * Authorization is enforced server-side (the route 403s a non-admin; the RPC's
 * `private.is_admin()` guard is the depth backstop). This control only renders
 * inside the admin-gated panel section.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "uphold" | "revert";

type Props = {
  disputeId: string;
  reportId: string;
  reason: string | null;
};

export default function DisputeReview({ disputeId, reportId, reason }: Props) {
  const router = useRouter();
  // `reportId` is part of the row contract (and keeps the control addressable to
  // its report) even though the write targets the dispute id.
  void reportId;

  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function review(action: Action) {
    if (pending) return;
    setPending(action);
    setError(null);

    try {
      const res = await fetch(`/api/disputes/${disputeId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        let message = "No se pudo resolver la disputa. Inténtalo de nuevo.";
        try {
          const body = await res.json();
          if (body?.error?.message) message = body.error.message;
        } catch {
          // non-JSON error body — keep the default message
        }
        setError(message);
        return;
      }

      router.refresh();
    } catch {
      setError("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="dispute-review">
      <p className="dispute-review__reason">{reason ?? "— sin motivo —"}</p>

      {error ? (
        <p className="dispute-review__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="dispute-review__actions">
        <button
          type="button"
          className="capture-btn capture-btn--secondary"
          onClick={() => review("uphold")}
          disabled={pending !== null}
        >
          {pending === "uphold" ? "Manteniendo…" : "Mantener resolución"}
        </button>
        <button
          type="button"
          className="capture-btn capture-btn--primary"
          onClick={() => review("revert")}
          disabled={pending !== null}
        >
          {pending === "revert" ? "Revirtiendo…" : "Revertir a en proceso"}
        </button>
      </div>
    </div>
  );
}
