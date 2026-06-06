"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { STATUS_LABELS } from "@/lib/reportLabels";

/**
 * Staff status-change control (step13, SCEN-009). A small form per report row:
 * a status `<select>`, an optional note `<textarea>`, and a "Guardar" button.
 * On submit it POSTs to `/api/reports/[id]/status` and, on success, calls
 * `router.refresh()` so the server-rendered row re-reads the new status.
 *
 * Shows a pending (disabled) state and a Spanish error on failure. Authorization
 * is enforced server-side (route 403 + RPC `private.is_staff()`); this control is
 * only rendered inside the staff-gated panel.
 */

const STATUS_OPTIONS = Object.entries(STATUS_LABELS) as Array<[string, string]>;

export default function StatusControl({
  reportId,
  currentStatus,
}: {
  reportId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const statusId = useId();
  const noteId = useId();

  const [status, setStatus] = useState(currentStatus);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch(`/api/reports/${reportId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note }),
      });

      if (!res.ok) {
        let message = "No se pudo cambiar el estado. Inténtalo de nuevo.";
        try {
          const body = await res.json();
          if (body?.error?.message) message = body.error.message;
        } catch {
          // non-JSON error body — keep the default message
        }
        setError(message);
        return;
      }

      setNote("");
      router.refresh();
    } catch {
      setError("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="status-control" onSubmit={onSubmit}>
      <div className="status-control__field">
        <label htmlFor={statusId}>Estado</label>
        <select
          id={statusId}
          value={status}
          disabled={pending}
          onChange={(e) => setStatus(e.target.value)}
        >
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="status-control__field">
        <label htmlFor={noteId}>Nota (opcional)</label>
        <textarea
          id={noteId}
          value={note}
          rows={2}
          maxLength={1000}
          disabled={pending}
          placeholder="Motivo o detalle del cambio"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error ? (
        <p className="status-control__error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="status-control__submit" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </button>
    </form>
  );
}
