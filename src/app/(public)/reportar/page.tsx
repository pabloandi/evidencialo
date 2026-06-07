import type { Metadata } from "next";
import Link from "next/link";

import CaptureForm from "@/components/capture/CaptureForm";

/**
 * Capture page (step15) — `/reportar`, the app's core citizen action.
 *
 * A thin RSC shell: it renders the page chrome (Spanish) and mounts the
 * `<CaptureForm/>` client component, which owns the photo/GPS/category/submit
 * flow. No dynamic server APIs here, so the shell prerenders; session presence
 * (captcha exemption) is resolved client-side inside the form.
 */

export const metadata: Metadata = {
  title: "Reportar un problema — evidencialo",
  description:
    "Toma una foto, elige la categoría y envía un reporte ciudadano con tu ubicación.",
};

export default function ReportarPage() {
  return (
    <main className="capture-shell">
      <header className="capture-shell__header">
        <Link className="capture-shell__back" href="/">
          ← Volver al mapa
        </Link>
        <h1 className="capture-shell__title">Reportar un problema</h1>
        <p className="capture-shell__subtitle">
          Toma una foto, elige la categoría y comparte tu ubicación.
        </p>
      </header>

      <CaptureForm />
    </main>
  );
}
