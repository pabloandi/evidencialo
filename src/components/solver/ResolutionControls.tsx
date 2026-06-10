"use client";

/**
 * Solver/staff control bar on the public report detail (chunk B2.3 —
 * solver-resolution.scenarios.md SCEN-001/002/003).
 *
 * RENDERS ONLY when the RSC has already authorized the viewer (staff OR
 * verified solver) — this component receives no role and performs NO gating; the
 * server gate in `/reportes/[id]/page.tsx` is the single source of truth, so an
 * anonymous/citizen viewer never receives this bundle at all.
 *
 * The bar is driven entirely by `status`:
 *   - `nuevo`      → "Reclamar" → POST status `en_proceso` → router.refresh().
 *   - `en_proceso` → "Subir evidencia" (toggles the proof panel) AND "Marcar
 *                    como resuelto" → POST status `resuelto`. The resolve button
 *                    is guarded while `hasProcessedProof === false` so the happy
 *                    path is obvious, but a 422 `proof_required` is STILL handled
 *                    (processing may lag the upload), showing an inline message.
 *   - `resuelto`   → no actions (a subtle confirmation only).
 *
 * The status write goes to the SAME audited route the panel uses
 * (`POST /api/reports/[id]/status`), which 403s a non-staff/solver caller and
 * 422s a proof-less resolve. `router.refresh()` re-runs the RSC so the new
 * attribution badge + "Después" media + enabled/disabled controls reflect the
 * fresh server state.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import ResolutionUpload from "./ResolutionUpload";

type Props = {
  reportId: string;
  /** The report's current `report_status` (e.g. `nuevo` | `en_proceso` | `resuelto`). */
  status: string;
  /** True when the detail service returned ≥1 processed `kind='resolution'` media
   *  — exactly the proof-gate precondition the resolve RPC enforces. */
  hasProcessedProof: boolean;
};

type Action = "claim" | "resolve";

type RequestState =
  | { kind: "idle" }
  | { kind: "sending"; action: Action }
  | { kind: "error"; message: string };

const STATUS_BY_ACTION: Record<Action, "en_proceso" | "resuelto"> = {
  claim: "en_proceso",
  resolve: "resuelto",
};

export default function ResolutionControls({
  reportId,
  status,
  hasProcessedProof,
}: Props) {
  const router = useRouter();
  const [request, setRequest] = useState<RequestState>({ kind: "idle" });
  const [uploadOpen, setUploadOpen] = useState(false);

  const sending = request.kind === "sending";

  async function changeStatus(action: Action) {
    if (sending) return;
    setRequest({ kind: "sending", action });

    try {
      const res = await fetch(`/api/reports/${reportId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: STATUS_BY_ACTION[action] }),
      });

      if (res.ok) {
        // Server state changed: re-run the RSC so the badge + media + the next
        // set of controls reflect it. Keep the bar disabled until refresh lands.
        router.refresh();
        return;
      }

      const body = await res.json().catch(() => null);
      // Processing may lag the upload, so a resolve can still 422 even when the
      // guard looked satisfied — surface the precise Spanish message.
      if (res.status === 422 && body?.error?.code === "proof_required") {
        setRequest({
          kind: "error",
          message: "Adjunta evidencia procesada antes de resolver.",
        });
        return;
      }

      setRequest({
        kind: "error",
        message:
          body?.error?.message ??
          "No se pudo actualizar el reporte. Inténtalo de nuevo.",
      });
    } catch {
      setRequest({
        kind: "error",
        message: "No se pudo conectar. Inténtalo de nuevo.",
      });
    }
  }

  // `resuelto` → terminal: a quiet confirmation, no actions.
  if (status === "resuelto") {
    return (
      <section className="solver-controls" aria-label="Acciones de resolución">
        <p className="solver-controls__done" role="status">
          ✓ Marcado como resuelto
        </p>
      </section>
    );
  }

  return (
    <section className="solver-controls" aria-label="Acciones de resolución">
      {status === "nuevo" && (
        <button
          type="button"
          className="capture-btn capture-btn--primary solver-controls__action"
          onClick={() => changeStatus("claim")}
          disabled={sending}
        >
          {request.kind === "sending" && request.action === "claim"
            ? "Reclamando…"
            : "Reclamar"}
        </button>
      )}

      {status === "en_proceso" && (
        <>
          <div className="solver-controls__row">
            <button
              type="button"
              className="capture-btn capture-btn--secondary"
              onClick={() => setUploadOpen((open) => !open)}
              aria-expanded={uploadOpen}
              aria-controls="solver-upload-panel"
            >
              {uploadOpen ? "Ocultar evidencia" : "Subir evidencia"}
            </button>
            <button
              type="button"
              className="capture-btn capture-btn--primary solver-controls__action"
              onClick={() => changeStatus("resolve")}
              disabled={sending || !hasProcessedProof}
              aria-describedby={
                hasProcessedProof ? undefined : "solver-proof-hint"
              }
            >
              {request.kind === "sending" && request.action === "resolve"
                ? "Resolviendo…"
                : "Marcar como resuelto"}
            </button>
          </div>

          {!hasProcessedProof && (
            <p
              id="solver-proof-hint"
              className="solver-controls__hint"
              role="note"
            >
              Sube evidencia procesada para poder marcar como resuelto.
            </p>
          )}

          {uploadOpen && (
            <div id="solver-upload-panel">
              <ResolutionUpload
                reportId={reportId}
                onUploaded={() => router.refresh()}
              />
            </div>
          )}
        </>
      )}

      {request.kind === "error" && (
        <p className="solver-controls__error" role="alert">
          {request.message}
        </p>
      )}
    </section>
  );
}
