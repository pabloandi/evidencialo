import SignOutButton from "@/components/auth/SignOutButton";
import DisputeReview from "@/components/panel/DisputeReview";
import SolverReputationList from "@/components/panel/SolverReputationList";
import StatusControl from "@/components/panel/StatusControl";
import { CATEGORY_LABELS, STATUS_LABELS } from "@/lib/reportLabels";
import { reliability } from "@/lib/reputation/reliability";
import { getSessionRole, isAdmin } from "@/lib/services/authz";
import { createServerSupabase } from "@/lib/supabase/server";
import { isCorroborated } from "@/lib/validation/corroboration";

/**
 * Staff management panel (step13). RSC — the `(panel)` layout already gates this
 * route to staff/admin, so here we just READ. The authenticated server client
 * reads `reports` under the `reports_select_staff` RLS policy, so staff see ALL
 * reports (including invisible ones).
 *
 * Filters come from the URL (`?status=&category=`, async in Next 16 — await
 * `searchParams`). We resolve the category SLUG to its id and apply `.eq`
 * filters conditionally, then render a filter bar (GET form) and the report
 * rows, each with a `<StatusControl>` for the audited change. The list is capped
 * at 100 to avoid the silent PostgREST 1000-row cap. No reporter PII is read.
 */

const STATUS_VALUES = new Set(["nuevo", "en_proceso", "resuelto", "descartado"]);

const ROW_LIMIT = 100;

type ReportRow = {
  id: string;
  status: string;
  created_at: string;
  is_visible: boolean;
  description: string | null;
  categories: { slug: string } | null;
  // Corroboration signal (subsystem A) — drives the priority ordering and the
  // per-row "N · M" / "Corroborado" marker.
  verified_count: number;
  anon_count: number;
  priority_score: number;
};

type CategoryRow = { id: string; slug: string };

/** Raw `solver_profiles` row for the admin reputation signal (subsystem C). */
type SolverProfileRow = {
  handle: string;
  resolved_count: number;
  upheld_count: number;
  reverted_count: number;
};

/** Mapped row passed to `SolverReputationList` (reliability derived per-row). */
type SolverReputationRow = {
  handle: string;
  resolvedCount: number;
  upheldCount: number;
  revertedCount: number;
  reliability: number | null;
};

type DisputeRow = {
  id: string;
  reason: string | null;
  created_at: string;
  report_id: string;
  reports: { status: string; categories: { slug: string } | null } | null;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CO", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function excerpt(text: string | null): string {
  if (!text) return "—";
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

export default async function PanelPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; category?: string }>;
}) {
  const { status: statusFilter, category: categoryFilter } = await searchParams;

  const supabase = await createServerSupabase();

  // Categories drive the filter UI AND let us resolve a slug filter to its id.
  const { data: categoriesData } = await supabase
    .from("categories")
    .select("id, slug")
    .order("slug");
  const categories = (categoriesData ?? []) as CategoryRow[];

  const validStatus =
    statusFilter && STATUS_VALUES.has(statusFilter) ? statusFilter : undefined;
  const selectedCategory = categories.find((c) => c.slug === categoryFilter);

  let query = supabase
    .from("reports")
    .select(
      "id, status, created_at, is_visible, description, verified_count, anon_count, priority_score, categories(slug)",
    )
    // Most-corroborated first (priority_score = verified + anon/4), then newest
    // — staff triage the reports citizens corroborated most before the rest.
    .order("priority_score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(ROW_LIMIT);

  if (validStatus) query = query.eq("status", validStatus);
  if (selectedCategory) query = query.eq("category_id", selectedCategory.id);

  const { data: reportsData, error } = await query;
  const reports = (reportsData ?? []) as unknown as ReportRow[];

  // Open disputes are ADMIN-ONLY (the `report_disputes` RLS read policy gates on
  // `private.is_admin()`). We mirror that here: resolve the role and only QUERY
  // when the viewer is an admin, so a plain staff session never sees the section
  // — and the RLS read would return nothing for them anyway (defense in depth).
  const { role } = await getSessionRole();
  const viewerIsAdmin = isAdmin(role);

  let openDisputes: DisputeRow[] = [];
  if (viewerIsAdmin) {
    const { data: disputesData } = await supabase
      .from("report_disputes")
      .select("id, reason, created_at, report_id, reports(status, categories(slug))")
      .eq("status", "open")
      .order("created_at", { ascending: true });
    openDisputes = (disputesData ?? []) as unknown as DisputeRow[];
  }

  // Admin reputation signal (subsystem C) — `solver_profiles` is world-readable,
  // so the SAME authenticated client reads it (no service-role needed). Order by
  // `reverted_count DESC` AT THE DB (the primary, problematic-first signal); the
  // reliability tiebreak is derived per-row and applied in JS as the SECONDARY
  // sort (the DB has no reliability column), ascending so the WORSE rate leads
  // among equal `reverted_count`. Admin-gated exactly like the disputes section.
  let solverRows: SolverReputationRow[] = [];
  if (viewerIsAdmin) {
    const { data: solversData } = await supabase
      .from("solver_profiles")
      .select("handle, resolved_count, upheld_count, reverted_count")
      .order("reverted_count", { ascending: false })
      .limit(ROW_LIMIT);

    solverRows = ((solversData ?? []) as unknown as SolverProfileRow[])
      .map((s) => ({
        handle: s.handle,
        resolvedCount: s.resolved_count,
        upheldCount: s.upheld_count,
        revertedCount: s.reverted_count,
        reliability: reliability(s.resolved_count, s.reverted_count),
      }))
      // Stable secondary sort: equal `reverted_count` → lower reliability first
      // (a `null` rate — no history — sorts last among equals). `Array.sort` is
      // stable in modern V8, so the DB's `reverted_count DESC` primary order is
      // preserved where the comparator returns 0.
      .sort((a, b) => {
        if (b.revertedCount !== a.revertedCount) {
          return b.revertedCount - a.revertedCount;
        }
        const ra = a.reliability ?? Number.POSITIVE_INFINITY;
        const rb = b.reliability ?? Number.POSITIVE_INFINITY;
        return ra - rb;
      });
  }

  // Staff identity for the header. The `(panel)` layout already gated this
  // route, so reading the user here just labels the session and offers sign-out.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="panel">
      <header className="panel__header">
        <div className="panel__session">
          <span className="panel__session-label">
            Sesión de staff{user?.email ? ` · ${user.email}` : ""}
          </span>
          <SignOutButton />
        </div>
        <h1>Panel de gestión</h1>
        <p className="panel__subtitle">
          {reports.length === ROW_LIMIT
            ? `Mostrando los ${ROW_LIMIT} reportes más recientes.`
            : `${reports.length} reporte${reports.length === 1 ? "" : "s"}.`}
        </p>
      </header>

      <form className="panel__filters" method="get">
        <div className="panel__filter">
          <label htmlFor="filter-status">Estado</label>
          <select id="filter-status" name="status" defaultValue={validStatus ?? ""}>
            <option value="">Todos</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="panel__filter">
          <label htmlFor="filter-category">Categoría</label>
          <select
            id="filter-category"
            name="category"
            defaultValue={selectedCategory?.slug ?? ""}
          >
            <option value="">Todas</option>
            {categories.map((c) => (
              <option key={c.id} value={c.slug}>
                {CATEGORY_LABELS[c.slug] ?? c.slug}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className="panel__filter-submit">
          Filtrar
        </button>
      </form>

      {viewerIsAdmin ? (
        <section className="panel__disputes" aria-label="Disputas abiertas">
          <h2 className="panel__disputes-title">Disputas abiertas</h2>
          {openDisputes.length === 0 ? (
            <p className="panel__disputes-empty">No hay disputas abiertas.</p>
          ) : (
            <ul className="panel__disputes-list">
              {openDisputes.map((d) => {
                const slug = d.reports?.categories?.slug ?? "";
                return (
                  <li key={d.id} className="panel-card panel-card--dispute">
                    <div className="panel-card__head">
                      <span className={`panel-card__category cat-${slug}`}>
                        {CATEGORY_LABELS[slug] ?? slug ?? "—"}
                      </span>
                      <a
                        className="panel-card__link"
                        href={`/reportes/${d.report_id}`}
                      >
                        Ver reporte
                      </a>
                      <time
                        className="panel-card__date"
                        dateTime={d.created_at}
                      >
                        {formatDate(d.created_at)}
                      </time>
                    </div>

                    <DisputeReview
                      disputeId={d.id}
                      reportId={d.report_id}
                      reason={d.reason}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {viewerIsAdmin ? (
        <section className="panel__solvers" aria-label="Solucionadores">
          <h2 className="panel__solvers-title">Solucionadores</h2>
          {solverRows.length === 0 ? (
            <p className="panel__solvers-empty-list">
              No hay solucionadores aún.
            </p>
          ) : (
            <SolverReputationList rows={solverRows} />
          )}
        </section>
      ) : null}

      {error ? (
        <p className="panel__empty" role="alert">
          No se pudieron cargar los reportes. Inténtalo de nuevo.
        </p>
      ) : reports.length === 0 ? (
        <p className="panel__empty">No hay reportes que coincidan con el filtro.</p>
      ) : (
        <ul className="panel__list">
          {reports.map((r) => {
            const slug = r.categories?.slug ?? "";
            return (
              // The key includes the server-confirmed status so a status change
              // (after router.refresh()) REMOUNTS the row — re-seeding
              // StatusControl's `useState(currentStatus)` instead of leaving a
              // stale select on a concurrent update (FIX 3).
              <li key={`${r.id}:${r.status}`} className="panel-card">
                <div className="panel-card__head">
                  <span className={`panel-card__category cat-${slug}`}>
                    {CATEGORY_LABELS[slug] ?? slug ?? "—"}
                  </span>
                  <span className={`panel-card__status status-${r.status}`}>
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                  {!r.is_visible ? (
                    <span className="panel-card__hidden" title="No visible en el mapa público">
                      Oculto
                    </span>
                  ) : null}
                  {isCorroborated(r.verified_count) ? (
                    <span
                      className="panel-card__corroborated"
                      title={`${r.verified_count} verificadas · ${r.anon_count} anónimas`}
                    >
                      Corroborado ✓
                    </span>
                  ) : (
                    <span
                      className="panel-card__counts"
                      title="Verificadas · anónimas"
                    >
                      {r.verified_count} · {r.anon_count}
                    </span>
                  )}
                  <time className="panel-card__date" dateTime={r.created_at}>
                    {formatDate(r.created_at)}
                  </time>
                </div>

                <p className="panel-card__desc">{excerpt(r.description)}</p>

                <StatusControl reportId={r.id} currentStatus={r.status} />
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
