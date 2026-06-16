import { describe, expect, it } from "vitest";

import {
  getSolverProfileByHandle,
  getSolverResolvedReports,
} from "./solverService";

// Observable contract for the public solver profile reads (chunk B2.4, SCEN-008)
// with a MOCKED admin client. Mirrors the reportDetailService test idiom: a fake
// `from(table)` whose chains record what the service asked for, plus a
// `storage.from().createSignedUrl()` stub. Covers: case-insensitive handle
// lookup, ilike-wildcard escaping (injection safety), unknown handle → null,
// resolved-reports filtered to resuelto+visible with before/after thumbs and NO
// reporter_id/location in the returned shape.

const SOLVER_ID = "22222222-2222-2222-2222-222222222222";

type SolverProfileRow = {
  id: string;
  handle: string;
  type: string;
  bio: string | null;
  avatar_url: string | null;
  links: Record<string, unknown> | null;
  resolved_count: number;
  upheld_count: number;
  reverted_count: number;
} | null;

type ResolvedReportRow = {
  id: string;
  created_at: string;
  resolved_at: string | null;
  categories: { slug: string } | null;
};

type ThumbRow = {
  storage_path: string;
  type: string;
  kind: string;
};

/**
 * Build a fake SupabaseClient.
 * - profileRow: row returned by the solver_profiles ilike lookup (null → 404).
 * - reportRows: rows returned by the reports lookup (already shaped as the
 *   service's select; the fake records the eq filters via `__inspect`).
 * - thumbsByReport: per-report media rows keyed by report id; the service asks
 *   for one `kind` at a time, so the fake filters on the recorded `kind` eq.
 * - signError: when set, createSignedUrl errors for that storage_path.
 */
function makeFakeClient(behavior: {
  profileRow?: SolverProfileRow;
  reportRows?: ResolvedReportRow[];
  thumbsByReport?: Record<string, ThumbRow[]>;
  signError?: (path: string) => boolean;
}) {
  const profileIlikes: Array<[string, unknown]> = [];
  const profileSelects: string[] = [];
  const reportEqs: Array<[string, unknown]> = [];
  const mediaEqs: Array<[string, unknown]> = [];
  const signedCalls: Array<{ path: string; ttl: number }> = [];

  const client = {
    from(table: string) {
      if (table === "solver_profiles") {
        return {
          select: (cols: string) => {
            profileSelects.push(cols);
            const builder = {
              ilike(col: string, val: unknown) {
                profileIlikes.push([col, val]);
                return builder;
              },
              async maybeSingle() {
                return { data: behavior.profileRow ?? null, error: null };
              },
            };
            return builder;
          },
        };
      }
      if (table === "reports") {
        return {
          select: () => {
            const builder = {
              eq(col: string, val: unknown) {
                reportEqs.push([col, val]);
                return builder;
              },
              order() {
                return builder;
              },
              returns() {
                return builder;
              },
              then(
                resolve: (v: {
                  data: ResolvedReportRow[];
                  error: null;
                }) => void,
              ) {
                resolve({ data: behavior.reportRows ?? [], error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "report_media") {
        return {
          select: () => {
            // Capture this chain's filters so we can resolve the right rows.
            const eqs: Record<string, unknown> = {};
            const builder = {
              eq(col: string, val: unknown) {
                eqs[col] = val;
                mediaEqs.push([col, val]);
                return builder;
              },
              order() {
                return builder;
              },
              limit() {
                return builder;
              },
              async maybeSingle() {
                const reportId = eqs.report_id as string;
                const kind = eqs.kind as string;
                const rows = behavior.thumbsByReport?.[reportId] ?? [];
                const row = rows.find((r) => r.kind === kind) ?? null;
                return {
                  data: row
                    ? { storage_path: row.storage_path, type: row.type }
                    : null,
                  error: null,
                };
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe("report-media");
        return {
          createSignedUrl: async (path: string, ttl: number) => {
            signedCalls.push({ path, ttl });
            if (behavior.signError?.(path)) {
              return { data: null, error: { message: "object not found" } };
            }
            return {
              data: { signedUrl: `https://signed.example/${path}?token=abc` },
              error: null,
            };
          },
        };
      },
    },
    __inspect: { profileIlikes, profileSelects, reportEqs, mediaEqs, signedCalls },
  };

  return client as unknown as Parameters<
    typeof getSolverProfileByHandle
  >[1] & {
    __inspect: {
      profileIlikes: Array<[string, unknown]>;
      profileSelects: string[];
      reportEqs: Array<[string, unknown]>;
      mediaEqs: Array<[string, unknown]>;
      signedCalls: Array<{ path: string; ttl: number }>;
    };
  };
}

describe("getSolverProfileByHandle", () => {
  it("returns the mapped public profile for a known handle (any case) with a Spanish type label (SCEN-008)", async () => {
    const client = makeFakeClient({
      profileRow: {
        id: SOLVER_ID,
        handle: "Alcaldia",
        type: "government",
        bio: "Equipo de obras públicas.",
        avatar_url: "https://cdn.example/a.png",
        links: { web: "https://alcaldia.gov" },
        resolved_count: 47,
        upheld_count: 3,
        reverted_count: 2,
      },
    });

    // Caller passes a different case than the stored handle.
    const profile = await getSolverProfileByHandle("ALCALDIA", client);

    expect(profile).not.toBeNull();
    expect(profile!.id).toBe(SOLVER_ID);
    expect(profile!.handle).toBe("Alcaldia");
    expect(profile!.type).toBe("government");
    expect(profile!.typeLabel).toBe("Gobierno");
    expect(profile!.bio).toBe("Equipo de obras públicas.");
    expect(profile!.avatarUrl).toBe("https://cdn.example/a.png");
    expect(profile!.links).toEqual({ web: "https://alcaldia.gov" });

    // Subsystem C (SCEN-007 service half): the three reputation counts map
    // straight from the snake_case columns onto the camelCase profile shape.
    expect(profile!.resolvedCount).toBe(47);
    expect(profile!.upheldCount).toBe(3);
    expect(profile!.revertedCount).toBe(2);

    // The lookup select asks the DB for the three count columns.
    expect(client.__inspect.profileSelects).toContainEqual(
      "id, handle, type, bio, avatar_url, links, resolved_count, upheld_count, reverted_count",
    );

    // The lookup uses a case-insensitive ilike on `handle`.
    expect(client.__inspect.profileIlikes).toContainEqual(["handle", "ALCALDIA"]);

    // No PII leaks into the public shape.
    expect(profile).not.toHaveProperty("verified_by");
    expect(profile).not.toHaveProperty("verifiedBy");
    expect(profile).not.toHaveProperty("verified_at");
  });

  it("returns null for an unknown handle (→ page 404s)", async () => {
    const client = makeFakeClient({ profileRow: null });

    const profile = await getSolverProfileByHandle("ghost", client);

    expect(profile).toBeNull();
    // It DID query (an unknown handle is only known to be unknown after the read).
    expect(client.__inspect.profileIlikes).toHaveLength(1);
  });

  it("returns null for an empty/whitespace handle WITHOUT querying", async () => {
    const client = makeFakeClient({ profileRow: { id: SOLVER_ID, handle: "x", type: "org", bio: null, avatar_url: null, links: {}, resolved_count: 0, upheld_count: 0, reverted_count: 0 } });

    expect(await getSolverProfileByHandle("", client)).toBeNull();
    expect(await getSolverProfileByHandle("   ", client)).toBeNull();
    // No query was issued — a bare/empty handle is rejected before the DB.
    expect(client.__inspect.profileIlikes).toHaveLength(0);
  });

  it("escapes ilike wildcards so `%`/`_`/`\\` match literally (no wildcard injection)", async () => {
    const client = makeFakeClient({ profileRow: null });

    await getSolverProfileByHandle("a%_\\b", client);

    // Each LIKE metachar is backslash-escaped → the filter is a literal match,
    // never a wildcard that could match the first/arbitrary profile.
    expect(client.__inspect.profileIlikes).toEqual([["handle", "a\\%\\_\\\\b"]]);
  });

  it("defaults links to {} when the column is null", async () => {
    const client = makeFakeClient({
      profileRow: {
        id: SOLVER_ID,
        handle: "org1",
        type: "org",
        bio: null,
        avatar_url: null,
        links: null,
        resolved_count: 0,
        upheld_count: 0,
        reverted_count: 0,
      },
    });

    const profile = await getSolverProfileByHandle("org1", client);

    expect(profile!.links).toEqual({});
    expect(profile!.typeLabel).toBe("Organización");
    // A freshly verified solver carries all-zero counts (the empty reputation
    // case the reliability helper renders as "Sin historial aún").
    expect(profile!.resolvedCount).toBe(0);
    expect(profile!.upheldCount).toBe(0);
    expect(profile!.revertedCount).toBe(0);
  });
});

describe("getSolverResolvedReports", () => {
  const R1 = "11111111-1111-1111-1111-111111111111";
  const R2 = "33333333-3333-3333-3333-333333333333";

  it("lists resuelto+visible reports newest-first with before/after thumbs and NO PII (SCEN-008)", async () => {
    const client = makeFakeClient({
      reportRows: [
        {
          id: R1,
          created_at: "2026-05-01T10:00:00Z",
          resolved_at: "2026-05-10T10:00:00Z",
          categories: { slug: "bache" },
        },
      ],
      thumbsByReport: {
        [R1]: [
          { storage_path: `${R1}/before.jpg`, type: "image", kind: "report" },
          {
            storage_path: `${R1}/after.jpg`,
            type: "image",
            kind: "resolution",
          },
        ],
      },
    });

    const reports = await getSolverResolvedReports(SOLVER_ID, client);

    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.id).toBe(R1);
    expect(r.category).toBe("bache");
    expect(r.categoryLabel).toBe("Bache");
    expect(r.resolvedAt).toBe("2026-05-10T10:00:00Z");
    expect(r.beforeThumb).toEqual({
      signedUrl: `https://signed.example/${R1}/before.jpg?token=abc`,
      type: "image",
    });
    expect(r.afterThumb).toEqual({
      signedUrl: `https://signed.example/${R1}/after.jpg?token=abc`,
      type: "image",
    });

    // The query filtered resolved_by + status=resuelto + is_visible=true.
    expect(client.__inspect.reportEqs).toContainEqual(["resolved_by", SOLVER_ID]);
    expect(client.__inspect.reportEqs).toContainEqual(["status", "resuelto"]);
    expect(client.__inspect.reportEqs).toContainEqual(["is_visible", true]);

    // Thumb queries scoped to processed media of the requested kind.
    expect(client.__inspect.mediaEqs).toContainEqual([
      "processing_state",
      "processed",
    ]);
    expect(client.__inspect.mediaEqs).toContainEqual(["kind", "report"]);
    expect(client.__inspect.mediaEqs).toContainEqual(["kind", "resolution"]);

    // No PII keys in the returned shape.
    expect(r).not.toHaveProperty("reporter_id");
    expect(r).not.toHaveProperty("location");
    expect(r).not.toHaveProperty("address");
  });

  it("omits a thumb whose signed URL fails to mint (non-fatal), keeps the report", async () => {
    const client = makeFakeClient({
      reportRows: [
        {
          id: R2,
          created_at: "2026-05-01T10:00:00Z",
          resolved_at: "2026-05-11T10:00:00Z",
          categories: { slug: "basura" },
        },
      ],
      thumbsByReport: {
        [R2]: [
          { storage_path: `${R2}/before.jpg`, type: "image", kind: "report" },
          {
            storage_path: `${R2}/after.jpg`,
            type: "image",
            kind: "resolution",
          },
        ],
      },
      signError: (path) => path.endsWith("/after.jpg"),
    });

    const reports = await getSolverResolvedReports(SOLVER_ID, client);

    expect(reports[0].beforeThumb).not.toBeNull();
    // The unsignable "after" is dropped to null; the card still renders.
    expect(reports[0].afterThumb).toBeNull();
  });

  it("returns null thumbs when a report has no processed media of a kind", async () => {
    const client = makeFakeClient({
      reportRows: [
        {
          id: R1,
          created_at: "2026-05-01T10:00:00Z",
          resolved_at: "2026-05-12T10:00:00Z",
          categories: { slug: "alumbrado" },
        },
      ],
      thumbsByReport: {
        [R1]: [
          { storage_path: `${R1}/before.jpg`, type: "image", kind: "report" },
        ],
      },
    });

    const reports = await getSolverResolvedReports(SOLVER_ID, client);

    expect(reports[0].beforeThumb).not.toBeNull();
    expect(reports[0].afterThumb).toBeNull();
  });

  it("returns [] for a solver with zero resolutions (page shows the empty state, not a 404)", async () => {
    const client = makeFakeClient({ reportRows: [] });

    const reports = await getSolverResolvedReports(SOLVER_ID, client);

    expect(reports).toEqual([]);
  });
});
