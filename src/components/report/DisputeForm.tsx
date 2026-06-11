"use client";

/**
 * Public "report a false resolution" form (subsystem B, chunk B3.2 —
 * solver-resolution.scenarios.md SCEN-007). Mounted on the report detail ONLY
 * when `status === 'resuelto'`: anyone (anon or authenticated) may flag a
 * resolution they believe is false, and an admin later upholds or reverts it.
 *
 * Flow mirrors `StatusControl`'s fetch/error contract:
 *   - Collapsed by default (a single toggle button) to keep the detail page calm.
 *   - Expanded: an OPTIONAL reason `<textarea>` (≤1000, matching the backend
 *     `disputeSchema` bound) and a submit button.
 *   - For ANONYMOUS callers it renders a `<TurnstileWidget>`; the widget
 *     self-hides when no site key is configured, so the captcha-exempt path is
 *     automatic (no key → no token → header omitted, exactly like CaptureForm).
 *   - `POST /api/reports/[id]/dispute` with `{ reason }`; the Turnstile token,
 *     when present, rides the `cf-turnstile-response` header.
 *   - On ok → success state (`role="status"`): the form is hidden.
 *   - On !ok → the server's Spanish `{error:{message}}` (`role="alert"`); a 409
 *     ("ya hay una disputa abierta") already carries a friendly message.
 */

import { useId, useState } from "react";

import TurnstileWidget from "@/components/captcha/TurnstileWidget";

type Props = {
  reportId: string;
  /** True when the viewer has no session → the captcha path applies. */
  anonymous: boolean;
};

export default function DisputeForm({ reportId, anonymous }: Props) {
  const reasonId = useId();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(anonymous && captchaToken
          ? { "cf-turnstile-response": captchaToken }
          : {}),
      };

      const res = await fetch(`/api/reports/${reportId}/dispute`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason }),
      });

      if (!res.ok) {
        let message = "No se pudo enviar el reporte. Inténtalo de nuevo.";
        try {
          const body = await res.json();
          if (body?.error?.message) message = body.error.message;
        } catch {
          // non-JSON error body — keep the default message
        }
        setError(message);
        return;
      }

      setDone(true);
    } catch {
      setError("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="dispute-form__success" role="status">
        Gracias. Un administrador revisará este reporte.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="dispute-form__toggle"
        onClick={() => setOpen(true)}
      >
        Reportar resolución falsa
      </button>
    );
  }

  return (
    <form className="dispute-form" onSubmit={onSubmit}>
      <label className="dispute-form__field" htmlFor={reasonId}>
        <span className="dispute-form__label">Motivo (opcional)</span>
        <textarea
          id={reasonId}
          className="dispute-form__reason"
          value={reason}
          rows={3}
          maxLength={1000}
          disabled={pending}
          placeholder="¿Por qué crees que no está resuelto? (opcional)"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>

      {anonymous && (
        <TurnstileWidget
          className="dispute-form__turnstile"
          onToken={setCaptchaToken}
        />
      )}

      {error ? (
        <p className="dispute-form__error" role="alert">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        className="dispute-form__submit"
        disabled={pending}
      >
        {pending ? "Enviando…" : "Enviar reporte"}
      </button>
    </form>
  );
}
