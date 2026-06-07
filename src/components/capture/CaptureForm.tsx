"use client";

/**
 * Citizen capture form (step15 — SCEN-001/002/004). The app's core action: a
 * citizen attaches a photo, picks a category, optionally writes a description,
 * captures their location, and submits.
 *
 * Submit flow (the real backend contract — see `src/app/api/reports/route.ts`
 * and `src/app/api/media/route.ts`):
 *   1. Client-side validation (photo + category + lat/lng) — a missing required
 *      field BLOCKS the submit with no network call (SCEN-002).
 *   2. `POST /api/reports` with a generated `Idempotency-Key` (and, for
 *      anonymous callers, the Turnstile `cf-turnstile-response`) → returns the
 *      report id + a signed media upload.
 *   3. Upload the RAW photo bytes to the signed URL via the browser Supabase
 *      client (`uploadToSignedUrl(path, token, file)`).
 *   4. `POST /api/media { report_id, media_id }` → strips EXIF/GPS + processes;
 *      the DB visibility trigger then makes the report public.
 *
 * Native vs web capture lives behind `src/lib/native/capture.ts`: the web file
 * input is always rendered (so the WebView and agent-browser can upload to it);
 * on a device an extra "Tomar foto" button uses the native camera plugin.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  CaptureError,
  capturePhotoNative,
  getPosition,
  isNative,
} from "@/lib/native/capture";
import { CATEGORY_LABELS } from "@/lib/reportLabels";
import { createBrowserSupabase } from "@/lib/supabase/browser";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const STORAGE_BUCKET = "report-media";

type CategoryOption = { slug: string; name: string };

type ReportsResponse = {
  report_id: string;
  media: {
    id: string;
    type: string;
    upload: { signedUrl: string; token: string; path: string };
  }[];
};

type SubmitStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string }
  | { kind: "success"; hasSession: boolean };

/** Fallback category list from the shared labels, used if the live fetch fails. */
const FALLBACK_CATEGORIES: CategoryOption[] = Object.entries(
  CATEGORY_LABELS,
).map(([slug, name]) => ({ slug, name }));

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: { sitekey: string; callback: (token: string) => void },
      ) => string;
    };
  }
}

export default function CaptureForm() {
  const [categories, setCategories] =
    useState<CategoryOption[]>(FALLBACK_CATEGORIES);
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  const [status, setStatus] = useState<SubmitStatus>({ kind: "idle" });
  const turnstileRef = useRef<HTMLDivElement | null>(null);

  // Resolve session presence (drives captcha exemption) + live categories.
  useEffect(() => {
    const supabase = createBrowserSupabase();
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (active) setHasSession(Boolean(data.session));
    });

    supabase
      .from("categories")
      .select("slug,name")
      .order("name")
      .then(({ data }) => {
        if (active && data && data.length > 0) {
          setCategories(data as CategoryOption[]);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  // Revoke the object URL when the preview changes / on unmount (no leak).
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const anonymous = hasSession === false;
  const needsCaptcha = anonymous && Boolean(TURNSTILE_SITE_KEY);

  // Load + render the Turnstile widget only for anonymous callers with a key.
  useEffect(() => {
    if (!needsCaptcha) return;
    const container = turnstileRef.current;
    if (!container) return;

    function renderWidget() {
      if (window.turnstile && container && container.childElementCount === 0) {
        window.turnstile.render(container, {
          sitekey: TURNSTILE_SITE_KEY!,
          callback: (token: string) => setCaptchaToken(token),
        });
      }
    }

    if (window.turnstile) {
      renderWidget();
      return;
    }

    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = renderWidget;
    document.head.appendChild(script);
  }, [needsCaptcha]);

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    applyFile(selected);
  }

  function applyFile(selected: File | null) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(selected ? URL.createObjectURL(selected) : null);
  }

  async function onTakePhotoNative() {
    try {
      const photo = await capturePhotoNative();
      applyFile(photo);
    } catch (error) {
      const message =
        error instanceof CaptureError
          ? error.message
          : "No se pudo tomar la foto.";
      setStatus({ kind: "error", message });
    }
  }

  async function onUseLocation() {
    setLocating(true);
    setLocationError(null);
    try {
      const position = await getPosition();
      setCoords(position);
    } catch (error) {
      setLocationError(
        error instanceof CaptureError
          ? error.message
          : "No se pudo obtener tu ubicación.",
      );
    } finally {
      setLocating(false);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status.kind === "sending") return;

    // --- Client-side validation FIRST: block with no network call (SCEN-002). ---
    if (!file) {
      setStatus({ kind: "error", message: "Adjunta una foto del problema." });
      return;
    }
    if (!category) {
      setStatus({ kind: "error", message: "Elige una categoría." });
      return;
    }
    if (!coords) {
      setStatus({
        kind: "error",
        message: "Captura tu ubicación con el botón “Usar mi ubicación”.",
      });
      return;
    }
    // Anonymous + captcha configured but not solved: block before the network.
    if (needsCaptcha && !captchaToken) {
      setStatus({
        kind: "error",
        message: "Completa la verificación de seguridad antes de enviar.",
      });
      return;
    }

    setStatus({ kind: "sending" });

    try {
      const idempotencyKey = crypto.randomUUID();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      };
      if (anonymous && captchaToken) {
        headers["cf-turnstile-response"] = captchaToken;
      }

      const reportRes = await fetch("/api/reports", {
        method: "POST",
        headers,
        body: JSON.stringify({
          category,
          lng: coords.lng,
          lat: coords.lat,
          description: description.trim() || undefined,
          media: [{ type: "image", mime: file.type, size: file.size }],
        }),
      });

      if (!reportRes.ok) {
        const body = await reportRes.json().catch(() => null);
        throw new Error(
          body?.error?.message ?? "No se pudo crear el reporte.",
        );
      }

      const report = (await reportRes.json()) as ReportsResponse;
      const mediaItem = report.media[0];
      if (!mediaItem) {
        throw new Error("La respuesta del servidor no incluyó la media.");
      }

      // Upload the RAW bytes to the signed upload URL via the browser client.
      const supabase = createBrowserSupabase();
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .uploadToSignedUrl(
          mediaItem.upload.path,
          mediaItem.upload.token,
          file,
        );
      if (uploadError) {
        throw new Error("No se pudo subir la foto. Inténtalo de nuevo.");
      }

      // Trigger strip-EXIF + processing; the visibility trigger publishes it.
      const mediaRes = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_id: report.report_id,
          media_id: mediaItem.id,
        }),
      });
      if (!mediaRes.ok) {
        const body = await mediaRes.json().catch(() => null);
        throw new Error(
          body?.error?.message ??
            "La foto se subió pero no se pudo procesar. Reintenta.",
        );
      }

      setStatus({ kind: "success", hasSession: Boolean(hasSession) });
    } catch (error) {
      setStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "No se pudo enviar el reporte. Inténtalo de nuevo.",
      });
    }
  }

  if (status.kind === "success") {
    return (
      <div className="capture-success" role="status">
        <h2 className="capture-success__title">¡Reporte enviado!</h2>
        <p className="capture-success__body">
          Se publicará en el mapa cuando termine de procesarse.
        </p>
        <Link
          className="capture-success__link"
          href={status.hasSession ? "/mis-reportes" : "/"}
        >
          {status.hasSession ? "Ver mis reportes" : "Volver al mapa"}
        </Link>
      </div>
    );
  }

  const sending = status.kind === "sending";

  return (
    <form className="capture-form" onSubmit={onSubmit} noValidate>
      <div className="capture-field">
        <span className="capture-field__label">Foto del problema</span>
        <label className="capture-photo" htmlFor="capture-photo-input">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="capture-photo__preview"
              src={previewUrl}
              alt="Vista previa de la foto del reporte"
            />
          ) : (
            <span className="capture-photo__placeholder">
              Toca para elegir o tomar una foto
            </span>
          )}
        </label>
        <input
          id="capture-photo-input"
          className="capture-photo__input"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onFileChange}
          aria-label="Foto del problema"
        />
        {isNative() && (
          <button
            type="button"
            className="capture-btn capture-btn--secondary"
            onClick={onTakePhotoNative}
          >
            Tomar foto
          </button>
        )}
      </div>

      <div className="capture-field">
        <label htmlFor="capture-category" className="capture-field__label">
          Categoría
        </label>
        <select
          id="capture-category"
          className="capture-select"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Elige una categoría…</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="capture-field">
        <label htmlFor="capture-description" className="capture-field__label">
          Descripción <span className="capture-field__hint">(opcional)</span>
        </label>
        <textarea
          id="capture-description"
          className="capture-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="Describe brevemente el problema…"
        />
      </div>

      <div className="capture-field">
        <span className="capture-field__label">Ubicación</span>
        <button
          type="button"
          className="capture-btn capture-btn--secondary"
          onClick={onUseLocation}
          disabled={locating}
        >
          {locating ? "Obteniendo ubicación…" : "Usar mi ubicación"}
        </button>
        {coords && (
          <p className="capture-coords" role="status">
            Ubicación capturada: {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
          </p>
        )}
        {locationError && (
          <p className="capture-error" role="alert">
            {locationError}
          </p>
        )}
      </div>

      {anonymous && TURNSTILE_SITE_KEY && (
        <div className="capture-field">
          <span className="capture-field__label">Verificación</span>
          <div ref={turnstileRef} className="capture-turnstile" />
        </div>
      )}

      {anonymous && !TURNSTILE_SITE_KEY && (
        <p className="capture-notice" role="note">
          Para enviar un reporte necesitas{" "}
          <Link href="/ingresar">iniciar sesión</Link>.
        </p>
      )}

      {status.kind === "error" && (
        <p className="capture-error" role="alert">
          {status.message}
        </p>
      )}

      <button
        type="submit"
        className="capture-btn capture-btn--primary"
        disabled={sending}
      >
        {sending ? "Enviando…" : "Enviar reporte"}
      </button>
    </form>
  );
}
