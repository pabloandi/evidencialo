import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getSessionRole } from "@/lib/services/authz";
import { CATEGORY_COLORS } from "@/lib/reportLabels";
import {
  getSolverProfileByHandle,
  getSolverResolvedReports,
  type SolverProfile,
  type SolverReportThumb,
  type SolverResolvedReport,
} from "@/lib/services/solverService";
import DonationBlock from "@/components/solver/DonationBlock";
import ReputationBlock from "@/components/solver/ReputationBlock";

/**
 * Public solver profile (chunk B2.4) — `/solucionadores/[handle]` (SCEN-008).
 *
 * A DYNAMIC RSC (the service-role admin client reads uncached, so the route is
 * server-rendered per request — fresh signed thumbnail URLs every time). It is
 * the public face of a verified solver: their identity (@handle, verified type,
 * bio, avatar) and the wall of `resuelto` reports they delivered, each with
 * before/after thumbnails. An UNKNOWN handle 404s (the service returns `null` →
 * `notFound()`); a known solver with zero resolutions renders the empty state.
 *
 * This component renders nothing the public reads did not return — no
 * `reporter_id`, no precise location, no `verified_by` (SCEN-008, no PII beyond
 * the public solver profile). Thumbnails come from the PRIVATE `report-media`
 * bucket via signed URLs minted server-side.
 */

// `generateMetadata` and the page body both need the profile. `cache()` dedupes
// them into ONE service-role read per request.
const loadProfile = cache(getSolverProfileByHandle);

type PageProps = {
  // Next 16: dynamic route params are async — they MUST be awaited.
  params: Promise<{ handle: string }>;
};

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { handle } = await params;
  const profile = await loadProfile(handle);
  if (!profile) {
    // The page body itself 404s; a generic title is fine for the not-found case.
    return { title: "Solucionador no encontrado — evidencialo" };
  }
  // No PII in the title — only the public handle.
  return { title: `@${profile.handle} — evidencialo` };
}

// Stable, deterministic Spanish date built from UTC parts (no timezone drift).
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

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

// One before/after thumbnail. Signed URLs from a private bucket can't be
// optimized by next/image (the URL carries a short-lived token), so a plain
// <img> is correct here. Videos render their first frame via a <video> poster
// fallback; here we keep it simple with a muted, preloaded frame.
function Thumb({
  thumb,
  label,
  alt,
}: {
  thumb: SolverReportThumb | null;
  label: string;
  alt: string;
}) {
  return (
    <figure className="solver-profile__thumb">
      <figcaption className="solver-profile__thumb-label">{label}</figcaption>
      {thumb ? (
        thumb.type === "video" ? (
          <video
            className="solver-profile__thumb-media"
            src={thumb.signedUrl}
            muted
            playsInline
            preload="metadata"
            aria-label={alt}
          />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="solver-profile__thumb-media"
            src={thumb.signedUrl}
            alt={alt}
            loading="lazy"
          />
        )
      ) : (
        <div
          className="solver-profile__thumb-media solver-profile__thumb-empty"
          aria-hidden="true"
        />
      )}
    </figure>
  );
}

function ReportCard({ report }: { report: SolverResolvedReport }) {
  const chipColor = CATEGORY_COLORS[report.category] ?? "#868E96";
  const resolvedDate = formatDate(report.resolvedAt);

  return (
    <li className="solver-profile__card-item">
      <Link href={`/reportes/${report.id}`} className="solver-profile__card">
        <div className="solver-profile__pair">
          <Thumb
            thumb={report.beforeThumb}
            label="Antes"
            alt={`Antes — ${report.categoryLabel}`}
          />
          <Thumb
            thumb={report.afterThumb}
            label="Después"
            alt={`Después — ${report.categoryLabel}`}
          />
        </div>
        <div className="solver-profile__card-meta">
          <span
            className="solver-profile__cat-chip"
            style={{ background: chipColor }}
          >
            {report.categoryLabel}
          </span>
          {resolvedDate && (
            <time
              className="solver-profile__card-date"
              dateTime={report.resolvedAt ?? undefined}
            >
              Resuelto el {resolvedDate}
            </time>
          )}
        </div>
      </Link>
    </li>
  );
}

function ProfileHeader({
  profile,
  isOwner,
}: {
  profile: SolverProfile;
  isOwner: boolean;
}) {
  return (
    <header className="solver-profile__header">
      {profile.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="solver-profile__avatar"
          src={profile.avatarUrl}
          alt=""
          width={88}
          height={88}
        />
      ) : (
        <div
          className="solver-profile__avatar solver-profile__avatar--placeholder"
          aria-hidden="true"
        >
          {profile.handle.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="solver-profile__identity">
        <h1 className="solver-profile__handle">@{profile.handle}</h1>
        <span className="solver-profile__type-chip">✓ {profile.typeLabel}</span>
        {profile.bio && <p className="solver-profile__bio">{profile.bio}</p>}
        <ReputationBlock
          resolvedCount={profile.resolvedCount}
          upheldCount={profile.upheldCount}
          revertedCount={profile.revertedCount}
        />
        {/* "Apóyalo" block — renders nothing when the solver has no channels. */}
        <DonationBlock channels={profile.donationChannels} />
        {/* Owner-only affordance: link to self-management. Visible only when the
            viewer IS this solver. */}
        {isOwner && (
          <Link
            href="/mi-perfil/donaciones"
            className="capture-btn capture-btn--secondary solver-profile__edit-donations"
          >
            Editar mis canales
          </Link>
        )}
      </div>
    </header>
  );
}

export default async function Page({ params }: PageProps) {
  const { handle } = await params;
  const profile = await loadProfile(handle);
  // SCEN-008: an unknown handle 404s — never render an empty shell.
  if (!profile) notFound();

  const [reports, { userId }] = await Promise.all([
    getSolverResolvedReports(profile.id),
    getSessionRole(),
  ]);
  // The owner sees an "Editar mis canales" affordance; everyone else does not.
  const isOwner = userId != null && userId === profile.id;

  return (
    <main className="solver-profile">
      <Link href="/" className="solver-profile__back">
        ← Volver al mapa
      </Link>

      <ProfileHeader profile={profile} isOwner={isOwner} />

      <section className="solver-profile__resolved" aria-label="Reportes resueltos">
        <h2 className="solver-profile__section-title">
          Reportes resueltos
          {reports.length > 0 && (
            <span className="solver-profile__count">{reports.length}</span>
          )}
        </h2>

        {reports.length === 0 ? (
          <p className="solver-profile__empty">Aún no hay reportes resueltos.</p>
        ) : (
          <ul className="solver-profile__grid">
            {reports.map((report) => (
              <ReportCard key={report.id} report={report} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
