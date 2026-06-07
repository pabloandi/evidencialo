import SignOutButton from "@/components/auth/SignOutButton";
import StatusControl from "@/components/panel/StatusControl";
import { CATEGORY_LABELS, STATUS_LABELS } from "@/lib/reportLabels";
import { createServerSupabase } from "@/lib/supabase/server";

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
};

type CategoryRow = { id: string; slug: string };

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
    .select("id, status, created_at, is_visible, description, categories(slug)")
    .order("created_at", { ascending: false })
    .limit(ROW_LIMIT);

  if (validStatus) query = query.eq("status", validStatus);
  if (selectedCategory) query = query.eq("category_id", selectedCategory.id);

  const { data: reportsData, error } = await query;
  const reports = (reportsData ?? []) as unknown as ReportRow[];

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
