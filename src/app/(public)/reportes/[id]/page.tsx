import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CATEGORY_COLORS } from "@/lib/reportLabels";
import { getPublicReportDetail } from "@/lib/services/reportDetailService";

/**
 * Public report detail (step12) — `/reportes/[id]`.
 *
 * A DYNAMIC RSC (the service-role admin client reads with `cache: 'no-store'`,
 * so the route is server-rendered per request — fresh signed URLs every time,
 * which is strictly safer than caching one near its expiry). It shows a VISIBLE
 * report's sanitized media, category, status, date and description. A non-visible
 * or unknown id 404s (the service returns `null` → `notFound()`), never leaking a
 * hidden report's existence. Media is served from the PRIVATE `report-media`
 * bucket via signed URLs minted server-side; this component renders nothing the
 * public read did not return — no `reporter_id`, no precise address.
 */

// `generateMetadata` and the page body both need the detail. `cache()` dedupes
// them into ONE service-role read + ONE round of signed-URL minting per request.
const loadDetail = cache(getPublicReportDetail);

type PageProps = {
  // Next 16: dynamic route params are async — they MUST be awaited.
  params: Promise<{ id: string }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const detail = await loadDetail(id);
  if (!detail) {
    // The page body itself 404s; a generic title is fine for the not-found case.
    return { title: "Reporte no encontrado — evidencialo" };
  }
  return { title: `${detail.categoryLabel} — evidencialo` };
}

// Stable, deterministic Spanish date (no relative "hoy/ayer" drift across the ISR
// cache window). Built from UTC parts so the cached output never depends on the
// server's local timezone.
const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const detail = await loadDetail(id);
  if (!detail) notFound();

  const chipColor = CATEGORY_COLORS[detail.category] ?? "#868E96";
  const date = formatDate(detail.createdAt);

  return (
    <main className="report-detail">
      <Link href="/" className="report-detail__back">
        ← Volver al mapa
      </Link>

      {detail.media.length > 0 && (
        <div className="report-detail__media">
          {detail.media.map((m) =>
            m.type === "video" ? (
              <video
                key={m.signedUrl}
                className="report-detail__hero"
                src={m.signedUrl}
                controls
                playsInline
                aria-label={detail.categoryLabel}
              />
            ) : (
              // Signed URLs from a private bucket can't be optimized by
              // next/image (no stable remote pattern; the URL carries a
              // short-lived token), so a plain <img> is correct here. width/height
              // come from the stored dimensions to reserve space (avoid CLS).
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                key={m.signedUrl}
                className="report-detail__hero"
                src={m.signedUrl}
                alt={detail.categoryLabel}
                width={m.width ?? undefined}
                height={m.height ?? undefined}
              />
            ),
          )}
        </div>
      )}

      <div className="report-detail__meta">
        <span
          className="report-detail__chip"
          style={{ background: chipColor }}
        >
          {detail.categoryLabel}
        </span>
        <span className="report-detail__badge">{detail.statusLabel}</span>
        {date && (
          <time className="report-detail__date" dateTime={detail.createdAt}>
            {date}
          </time>
        )}
      </div>

      {detail.description && (
        <p className="report-detail__description">{detail.description}</p>
      )}
    </main>
  );
}
