"use client";

/**
 * Solver proof-upload panel (chunk B2.3 — solver-resolution.scenarios.md
 * SCEN-002). The solver picks one or more photos and/or a video as PROOF of the
 * fix, then the panel runs the SAME signed-upload chain the citizen capture flow
 * uses, against the resolution-media route:
 *
 *   1. POST /api/reports/[id]/resolution-media with the `{ media: [...] }`
 *      manifest → 201 `{ media: [{ id, type, upload: { signedUrl, token, path } }] }`
 *      (identical contract to POST /api/reports).
 *   2. For each file, PUT the raw bytes to its signed upload URL
 *      (`uploadBytesToSignedUrl`, shared with CaptureForm via `mediaUpload.ts`).
 *   3. For each IMAGE, POST /api/media to strip EXIF + mark it processed
 *      (`processUploadedImage`). Video is sanitized asynchronously, so it stays
 *      pending briefly and is NOT posted to /api/media here.
 *
 * On success it calls `onUploaded()` (the parent runs `router.refresh()`), so the
 * new "Después" media and the now-enabled resolve button appear. The mechanics
 * are shared with CaptureForm rather than re-implemented; CaptureForm itself is
 * unchanged.
 */

import { useEffect, useRef, useState } from "react";

import {
  processUploadedImage,
  uploadBytesToSignedUrl,
} from "@/lib/native/mediaUpload";
import { createBrowserSupabase } from "@/lib/supabase/browser";

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIME = "video/mp4";

type Props = {
  reportId: string;
  /** Invoked after the proof has been uploaded + processing triggered, so the
   *  parent can re-run the RSC (router.refresh) and reveal the new media. */
  onUploaded: () => void;
};

type AttachResponse = {
  media: {
    id: string;
    type: string;
    upload: { signedUrl: string; token: string; path: string };
  }[];
};

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "error"; message: string };

/** Map a picked File to the manifest media item the route validates. */
function toManifestItem(file: File): { type: "image" | "video"; mime: string; size: number } {
  return {
    type: file.type === VIDEO_MIME ? "video" : "image",
    mime: file.type,
    size: file.size,
  };
}

export default function ResolutionUpload({ reportId, onUploaded }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const previewsRef = useRef<string[]>([]);

  // Revoke object URLs on change / unmount (no leak) — mirrors CaptureForm.
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);
  useEffect(() => {
    return () => {
      previewsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function onFilesChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    previews.forEach((url) => URL.revokeObjectURL(url));
    setFiles(picked);
    setPreviews(picked.map((f) => URL.createObjectURL(f)));
    setState({ kind: "idle" });
  }

  async function onUpload() {
    if (state.kind === "uploading") return;

    if (files.length === 0) {
      setState({
        kind: "error",
        message: "Elige al menos una foto o un video como evidencia.",
      });
      return;
    }
    // Client-side guard so an unsupported pick blocks before the network; the
    // route re-validates the same limits authoritatively.
    const unsupported = files.find(
      (f) => !IMAGE_MIMES.has(f.type) && f.type !== VIDEO_MIME,
    );
    if (unsupported) {
      setState({
        kind: "error",
        message: "Formato no permitido. Usa JPEG, PNG, WebP o MP4.",
      });
      return;
    }

    setState({ kind: "uploading" });

    try {
      // 1) Mint signed uploads for the proof manifest.
      const attachRes = await fetch(
        `/api/reports/${reportId}/resolution-media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ media: files.map(toManifestItem) }),
        },
      );
      if (!attachRes.ok) {
        const body = await attachRes.json().catch(() => null);
        throw new Error(
          body?.error?.message ??
            "No se pudo preparar la subida de evidencia. Reintenta.",
        );
      }

      const { media } = (await attachRes.json()) as AttachResponse;
      if (!media || media.length !== files.length) {
        throw new Error("La respuesta del servidor no coincide con los archivos.");
      }

      const supabase = createBrowserSupabase();

      // 2 + 3) Upload bytes, then trigger processing for images (shared helpers).
      for (let i = 0; i < media.length; i++) {
        const item = media[i];
        const file = files[i];
        await uploadBytesToSignedUrl(supabase, item.upload, file);
        if (item.type === "image") {
          await processUploadedImage(reportId, item.id);
        }
      }

      // 4) Done — let the parent refresh the RSC so "Después" + resolve appear.
      setFiles([]);
      previews.forEach((url) => URL.revokeObjectURL(url));
      setPreviews([]);
      setState({ kind: "idle" });
      onUploaded();
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "No se pudo subir la evidencia. Inténtalo de nuevo.",
      });
    }
  }

  const uploading = state.kind === "uploading";

  return (
    <div className="solver-upload">
      <label className="solver-upload__pick" htmlFor="solver-proof-input">
        <span className="solver-upload__label">Evidencia del arreglo</span>
        <span className="solver-upload__hint">
          Fotos (JPEG, PNG, WebP) o un video (MP4)
        </span>
      </label>
      <input
        id="solver-proof-input"
        className="solver-upload__input"
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4"
        multiple
        onChange={onFilesChange}
        aria-label="Evidencia del arreglo"
      />

      {previews.length > 0 && (
        <ul className="solver-upload__previews">
          {files.map((file, i) => (
            <li className="solver-upload__preview" key={`${file.name}-${i}`}>
              {file.type === VIDEO_MIME ? (
                <video
                  className="solver-upload__thumb"
                  src={previews[i]}
                  muted
                  playsInline
                  aria-label={`Evidencia ${i + 1}`}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="solver-upload__thumb"
                  src={previews[i]}
                  alt={`Evidencia ${i + 1}`}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {state.kind === "error" && (
        <p className="solver-upload__error" role="alert">
          {state.message}
        </p>
      )}

      <button
        type="button"
        className="capture-btn capture-btn--primary solver-upload__submit"
        onClick={onUpload}
        disabled={uploading || files.length === 0}
      >
        {uploading ? "Subiendo…" : "Subir evidencia"}
      </button>
    </div>
  );
}
