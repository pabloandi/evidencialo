"use client";

/**
 * Citizen corroboration control (subsystem A, chunk A3) — the "yo también lo veo"
 * confirm CTA mounted on a VALIDATABLE report detail (`nuevo`/`en_proceso`).
 *
 * Mirrors `DisputeForm`'s fetch/error contract:
 *   - For ANONYMOUS callers it renders a `<TurnstileWidget>`; the widget
 *     self-hides when no site key is configured, so the captcha-exempt path is
 *     automatic (no key → no token → header omitted, exactly like DisputeForm).
 *   - `POST /api/reports/[id]/validate`; the Turnstile token, when present, rides
 *     the `cf-turnstile-response` header. No JSON body is needed.
 *   - On ok (BOTH 201 newly-added AND 200 already-validated are `res.ok`) → parse
 *     the camelCase `{ verifiedCount, anonCount, corroborated }` body, update the
 *     LIVE counts + badge, and switch to the calm "Ya confirmaste" note
 *     (`role="status"`). 200 means the viewer had already confirmed.
 *   - On !ok → the server's Spanish `{error:{message}}` (`role="alert"`).
 *
 * The displayed `<CorroboratedBadge>` always reflects the LIVE counts (seeded
 * from props, then updated from the confirm response).
 */

import { useState } from "react";

import TurnstileWidget from "@/components/captcha/TurnstileWidget";
import CorroboratedBadge from "@/components/report/CorroboratedBadge";

type Props = {
  reportId: string;
  /** True when the viewer has no session → the captcha path applies. */
  anonymous: boolean;
  verifiedCount: number;
  anonCount: number;
  corroborated: boolean;
  /** True when the viewer already corroborated → render the done state directly. */
  hasValidated: boolean;
};

type ValidateResponse = {
  verifiedCount: number;
  anonCount: number;
  corroborated: boolean;
};

export default function ValidationControl({
  reportId,
  anonymous,
  verifiedCount,
  anonCount,
  corroborated,
  hasValidated,
}: Props) {
  const [counts, setCounts] = useState({
    verifiedCount,
    anonCount,
    corroborated,
  });
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(hasValidated);

  async function onConfirm() {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const headers: Record<string, string> =
        anonymous && captchaToken
          ? { "cf-turnstile-response": captchaToken }
          : {};

      const res = await fetch(`/api/reports/${reportId}/validate`, {
        method: "POST",
        headers,
      });

      if (!res.ok) {
        let message = "No se pudo confirmar. Inténtalo de nuevo.";
        try {
          const body = await res.json();
          if (body?.error?.message) message = body.error.message;
        } catch {
          // non-JSON error body — keep the default message
        }
        setError(message);
        return;
      }

      // Both 201 (newly added) and 200 (idempotent — already confirmed) are
      // `res.ok` and carry the camelCase counts body. Update + mark done.
      try {
        const body = (await res.json()) as Partial<ValidateResponse>;
        if (
          typeof body.verifiedCount === "number" &&
          typeof body.anonCount === "number" &&
          typeof body.corroborated === "boolean"
        ) {
          setCounts({
            verifiedCount: body.verifiedCount,
            anonCount: body.anonCount,
            corroborated: body.corroborated,
          });
        }
      } catch {
        // Missing/non-JSON success body — keep the optimistic seeded counts.
      }
      setDone(true);
    } catch {
      setError("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="validation-control">
      <CorroboratedBadge
        verifiedCount={counts.verifiedCount}
        anonCount={counts.anonCount}
        corroborated={counts.corroborated}
      />

      {done ? (
        <p className="validation-control__done" role="status">
          Ya confirmaste este reporte.
        </p>
      ) : (
        <>
          {anonymous && (
            <TurnstileWidget
              className="validation-control__turnstile"
              onToken={setCaptchaToken}
            />
          )}

          {error ? (
            <p className="validation-control__error" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            className="validation-control__submit"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? "Confirmando…" : "Confirmar — yo también lo veo"}
          </button>
        </>
      )}
    </div>
  );
}
