import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CATEGORY_COLORS } from "@/lib/reportLabels";
import { getSessionRole, isSolver, isStaff } from "@/lib/services/authz";
import {
  getPublicReportDetail,
  type ReportDetailMedia,
  type SolverAttribution,
} from "@/lib/services/reportDetailService";
import ResolutionControls from "@/components/solver/ResolutionControls";

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

// One sanitized media object. Signed URLs from a private bucket can't be
// optimized by next/image (no stable remote pattern; the URL carries a
// short-lived token), so a plain <img> is correct here. width/height come from
// the stored dimensions to reserve space (avoid CLS).
function MediaItem({ media, alt }: { media: ReportDetailMedia; alt: string }) {
  if (media.type === "video") {
    return (
      <video
        className="report-detail__hero"
        src={media.signedUrl}
        controls
        playsInline
        aria-label={alt}
      />
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      className="report-detail__hero"
      src={media.signedUrl}
      alt={alt}
      width={media.width ?? undefined}
      height={media.height ?? undefined}
    />
  );
}

// "Resuelto por @handle" / "En proceso por @handle" with the verified-type chip.
// Renders ONLY when an attribution exists (a staff/anonymous action yields null →
// the caller shows just the status, which is correct, not an error).
function AttributionBadge({
  attribution,
  verb,
}: {
  attribution: SolverAttribution;
  verb: string;
}) {
  return (
    <div className="solver-attribution">
      {attribution.avatarUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="solver-attribution__avatar"
          src={attribution.avatarUrl}
          alt=""
          width={32}
          height={32}
        />
      )}
      <span className="solver-attribution__text">
        {verb} <span className="solver-attribution__handle">@{attribution.handle}</span>
      </span>
      <span className="solver-attribution__chip">
        ✓ {attribution.typeLabel}
      </span>
    </div>
  );
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const detail = await loadDetail(id);
  if (!detail) notFound();

  // Resolve the viewer's role SERVER-SIDE so the solver controls never reach an
  // anonymous/citizen bundle. `getSessionRole` fails closed (role null on any
  // uncertainty); staff retain resolve powers, so the gate is staff OR solver.
  const { role } = await getSessionRole();
  const canResolve = isSolver(role) || isStaff(role);

  const chipColor = CATEGORY_COLORS[detail.category] ?? "#868E96";
  const date = formatDate(detail.createdAt);

  // Split media on `kind`: original complaint ("Antes") vs proof of fix ("Después").
  const beforeMedia = detail.media.filter((m) => m.kind === "report");
  const afterMedia = detail.media.filter((m) => m.kind === "resolution");
  // The detail service returns only PROCESSED media, so any resolution item here
  // is exactly the proof-gate precondition the resolve RPC enforces.
  const hasProcessedProof = afterMedia.length > 0;

  return (
    <main className="report-detail">
      <Link href="/" className="report-detail__back">
        ← Volver al mapa
      </Link>

      {beforeMedia.length > 0 && (
        <section className="report-detail__media" aria-label="Antes">
          <h2 className="report-detail__media-title">Antes</h2>
          {beforeMedia.map((m) => (
            <MediaItem key={m.signedUrl} media={m} alt={detail.categoryLabel} />
          ))}
        </section>
      )}

      {afterMedia.length > 0 && (
        <section className="report-detail__media" aria-label="Después">
          <h2 className="report-detail__media-title">Después</h2>
          {afterMedia.map((m) => (
            <MediaItem
              key={m.signedUrl}
              media={m}
              alt={`Evidencia de resolución — ${detail.categoryLabel}`}
            />
          ))}
        </section>
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

      {detail.status === "resuelto" && detail.resolvedBy && (
        <AttributionBadge attribution={detail.resolvedBy} verb="Resuelto por" />
      )}
      {detail.status === "en_proceso" && detail.claimedBy && (
        <AttributionBadge attribution={detail.claimedBy} verb="En proceso por" />
      )}

      {detail.description && (
        <p className="report-detail__description">{detail.description}</p>
      )}

      {canResolve && (
        <ResolutionControls
          reportId={id}
          status={detail.status}
          hasProcessedProof={hasProcessedProof}
        />
      )}
    </main>
  );
}
