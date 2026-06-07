import type { Metadata } from "next";
import Link from "next/link";

import { getSessionRole } from "@/lib/services/authz";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  STATUS_LABELS,
} from "@/lib/reportLabels";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Citizen "mis reportes" (step14) — `/mis-reportes`.
 *
 * An RSC that reads through the USER's cookie-bound server client (NOT the admin
 * client), so the RLS policy `reports_select_own` (`reporter_id = auth.uid()`,
 * migration 0003) scopes the result to the signed-in user's OWN reports —
 * including ones that are not yet publicly visible (the policy does not filter
 * on `is_visible`). The `(account)` layout already gated this route to an
 * authenticated session.
 *
 * A non-visible report shows its status inline but does NOT link to the public
 * detail `/reportes/[id]`, which 404s for non-visible reports (step12); only a
 * visible report gets a "Ver detalle" link (SCEN-001/005). No PII beyond the
 * user's own rows is read.
 */

export const metadata: Metadata = {
  title: "Mis reportes — evidencialo",
};

const ROW_LIMIT = 100;

type ReportRow = {
  id: string;
  status: string;
  created_at: string;
  is_visible: boolean;
  description: string | null;
  categories: { slug: string } | null;
};

// Deterministic Spanish date built from UTC parts (same style as the public
// detail page) so the rendered string never depends on the server timezone.
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

function excerpt(text: string | null): string {
  if (!text) return "Sin descripción.";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

export default async function MisReportesPage() {
  const { userId } = await getSessionRole();
  const supabase = await createServerSupabase();

  // Scope to the user's OWN reports EXPLICITLY. RLS alone is not enough here:
  // `reports` has multiple PERMISSIVE select policies that are OR-ed, so
  // `reports_select_public` (is_visible = true) would also let this query read
  // every public report — not just the user's. The explicit `reporter_id` filter
  // (matching `reports_select_own`) is the real scoping; RLS is defense in depth.
  // The `(account)` layout guarantees a session, so `userId` is non-null here.
  const { data, error } = await supabase
    .from("reports")
    .select("id, status, created_at, is_visible, description, categories(slug)")
    .eq("reporter_id", userId ?? "")
    .order("created_at", { ascending: false })
    .limit(ROW_LIMIT);

  const reports = (data ?? []) as unknown as ReportRow[];

  return (
    <main className="my-reports">
      <header className="my-reports__header">
        <Link href="/" className="my-reports__back">
          ← Volver al mapa
        </Link>
        <h1 className="my-reports__title">Mis reportes</h1>
        <p className="my-reports__subtitle">
          Sigue el estado de los reportes que has enviado, incluso antes de que
          sean públicos.
        </p>
      </header>

      {error ? (
        <p className="my-reports__empty" role="alert">
          No se pudieron cargar tus reportes. Inténtalo de nuevo.
        </p>
      ) : reports.length === 0 ? (
        <p className="my-reports__empty">Aún no tienes reportes.</p>
      ) : (
        <ul className="my-reports__list">
          {reports.map((r) => {
            const slug = r.categories?.slug ?? "";
            const date = formatDate(r.created_at);
            return (
              <li key={r.id} className="my-reports__card">
                <div className="my-reports__head">
                  <span
                    className="my-reports__category"
                    style={{
                      background: CATEGORY_COLORS[slug] ?? "#868e96",
                    }}
                  >
                    {CATEGORY_LABELS[slug] ?? slug ?? "Reporte"}
                  </span>
                  <span className="my-reports__status">
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                  {!r.is_visible && (
                    <span
                      className="my-reports__hidden"
                      title="Aún no aparece en el mapa público"
                    >
                      No visible aún
                    </span>
                  )}
                  {date && (
                    <time
                      className="my-reports__date"
                      dateTime={r.created_at}
                    >
                      {date}
                    </time>
                  )}
                </div>

                <p className="my-reports__desc">{excerpt(r.description)}</p>

                {/* A non-visible report has no public detail (it 404s, step12),
                    so only link a visible one. */}
                {r.is_visible && (
                  <Link
                    href={`/reportes/${r.id}`}
                    className="my-reports__link"
                  >
                    Ver detalle →
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
