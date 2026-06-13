import { describe, expect, it } from "vitest";

import { getPublicReportDetail } from "./reportDetailService";

// Observable contract for getPublicReportDetail (step12) with a MOCKED admin
// client. The service reads ONE visible report joined to its category, reads its
// PROCESSED media, and mints a download signed URL per media object. The fake
// covers: the report `.from('reports').select().eq().eq().maybeSingle()` chain,
// the media `.from('report_media').select().eq().eq().order()` chain, and
// `storage.from().createSignedUrl()`. SCEN-002 (invisible→null), SCEN-003
// (malformed id→null, no DB call), SCEN-004 (processed-only), SCEN-005 (signed
// URL + no reporter_id in the returned object).

const VISIBLE_ID = "11111111-1111-1111-1111-111111111111";

type ReportRow = {
  id: string;
  status: string;
  created_at: string;
  description: string | null;
  categories: { slug: string } | null;
  claimed_by?: string | null;
  resolved_by?: string | null;
  verified_count?: number;
  anon_count?: number;
} | null;

type MediaRow = {
  storage_path: string;
  type: string;
  width: number | null;
  height: number | null;
  processing_state: string;
  created_at: string;
  kind?: string;
};

type SolverProfileRow = {
  id: string;
  handle: string;
  type: string;
  avatar_url: string | null;
};

/**
 * Build a fake SupabaseClient.
 * - reportRow: row returned by the reports+category lookup (null -> not found)
 * - mediaRows: rows returned by the report_media lookup (already filtered to the
 *   `eq('processing_state','processed')` the service applies — the fake asserts
 *   the service DID apply that filter via `__inspect.mediaEqs`).
 * - signError: when set, createSignedUrl returns an error for that storage_path.
 */
function makeFakeClient(behavior: {
  reportRow?: ReportRow;
  mediaRows?: MediaRow[];
  solverProfiles?: SolverProfileRow[];
  signError?: (path: string) => boolean;
  /** When true, the report_validations EXISTS lookup returns a row (the viewer
   * already corroborated). When false/absent, it returns null. */
  viewerHasValidated?: boolean;
}) {
  const signedCalls: Array<{ path: string; ttl: number }> = [];
  const reportEqs: Array<[string, unknown]> = [];
  const mediaEqs: Array<[string, unknown]> = [];
  const solverInIds: string[][] = [];
  const validationEqs: Array<[string, unknown]> = [];

  const client = {
    from(table: string) {
      if (table === "reports") {
        return {
          select: () => {
            const builder = {
              eq(col: string, val: unknown) {
                reportEqs.push([col, val]);
                return builder;
              },
              async maybeSingle() {
                const row = behavior.reportRow ?? null;
                return {
                  // Mirror PostgREST: a selected-but-unset uuid column comes back
                  // as null, never undefined — normalize so the service's
                  // null-checks behave as they would against the real DB. The
                  // corroboration counters default to 0 (migration-0018 NOT NULL
                  // DEFAULT 0), so existing fixtures need not set them.
                  data: row
                    ? {
                        claimed_by: null,
                        resolved_by: null,
                        verified_count: 0,
                        anon_count: 0,
                        ...row,
                      }
                    : null,
                  error: null,
                };
              },
            };
            return builder;
          },
        };
      }
      if (table === "report_media") {
        return {
          select: () => {
            const builder = {
              eq(col: string, val: unknown) {
                mediaEqs.push([col, val]);
                return builder;
              },
              order() {
                return builder;
              },
              returns() {
                return builder;
              },
              // The service awaits the builder after `.returns()`; make it a
              // thenable that resolves to the processed media rows. `kind`
              // defaults to 'report' to mirror the DB column default.
              then(
                resolve: (v: {
                  data: MediaRow[];
                  error: null;
                }) => void,
              ) {
                const rows = (behavior.mediaRows ?? []).map((r) => ({
                  kind: "report",
                  ...r,
                }));
                resolve({ data: rows, error: null });
              },
            };
            return builder;
          },
        };
      }
      if (table === "report_validations") {
        return {
          select: () => {
            const builder = {
              eq(col: string, val: unknown) {
                validationEqs.push([col, val]);
                return builder;
              },
              async maybeSingle() {
                return {
                  data: behavior.viewerHasValidated
                    ? { report_id: VISIBLE_ID }
                    : null,
                  error: null,
                };
              },
            };
            return builder;
          },
        };
      }
      if (table === "solver_profiles") {
        return {
          select: () => {
            const builder = {
              in(_col: string, ids: string[]) {
                solverInIds.push(ids);
                return builder;
              },
              returns() {
                return builder;
              },
              then(
                resolve: (v: {
                  data: SolverProfileRow[];
                  error: null;
                }) => void,
              ) {
                resolve({ data: behavior.solverProfiles ?? [], error: null });
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
    __inspect: { signedCalls, reportEqs, mediaEqs, solverInIds, validationEqs },
  };

  return client as unknown as Parameters<typeof getPublicReportDetail>[1] & {
    __inspect: {
      signedCalls: Array<{ path: string; ttl: number }>;
      reportEqs: Array<[string, unknown]>;
      mediaEqs: Array<[string, unknown]>;
      solverInIds: string[][];
      validationEqs: Array<[string, unknown]>;
    };
  };
}

describe("getPublicReportDetail", () => {
  it("returns the mapped detail with Spanish labels and a signed media URL (SCEN-001/005)", async () => {
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "en_proceso",
        created_at: "2026-05-01T10:00:00Z",
        description: "Bache profundo frente al colegio.",
        categories: { slug: "bache" },
      },
      mediaRows: [
        {
          storage_path: `${VISIBLE_ID}/0.jpg`,
          type: "image",
          width: 800,
          height: 600,
          processing_state: "processed",
          created_at: "2026-05-01T10:00:00Z",
        },
      ],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(VISIBLE_ID);
    expect(detail!.category).toBe("bache");
    expect(detail!.categoryLabel).toBe("Bache");
    expect(detail!.status).toBe("en_proceso");
    expect(detail!.statusLabel).toBe("En proceso");
    expect(detail!.createdAt).toBe("2026-05-01T10:00:00Z");
    expect(detail!.description).toBe("Bache profundo frente al colegio.");

    expect(detail!.media).toHaveLength(1);
    expect(detail!.media[0].type).toBe("image");
    expect(detail!.media[0].width).toBe(800);
    expect(detail!.media[0].height).toBe(600);
    // SCEN-005: the URL is the SIGNED URL returned by createSignedUrl, not a
    // public/guessable object path.
    expect(detail!.media[0].signedUrl).toBe(
      `https://signed.example/${VISIBLE_ID}/0.jpg?token=abc`,
    );

    // The report query filtered on BOTH id AND is_visible=true (defense in depth).
    expect(client.__inspect.reportEqs).toContainEqual(["id", VISIBLE_ID]);
    expect(client.__inspect.reportEqs).toContainEqual(["is_visible", true]);

    // The signed URL was minted with a long TTL (>= revalidate window).
    expect(client.__inspect.signedCalls[0].path).toBe(`${VISIBLE_ID}/0.jpg`);
    expect(client.__inspect.signedCalls[0].ttl).toBe(86400);

    // Corroboration fields (subsystem A): default counts (0) → not corroborated,
    // and an anonymous viewer (no viewerId) is never "hasValidated".
    expect(detail!.verifiedCount).toBe(0);
    expect(detail!.anonCount).toBe(0);
    expect(detail!.corroborated).toBe(false);
    expect(detail!.hasValidated).toBe(false);
    // No viewerId → the per-viewer validation lookup is NEVER issued.
    expect(client.__inspect.validationEqs).toHaveLength(0);
  });

  it("exposes raw counts and DERIVES corroborated from verified_count (subsystem A, A2.3)", async () => {
    // verified_count >= CORROBORATION_THRESHOLD (3) earns the badge; anon_count
    // is carried through verbatim and never feeds the badge.
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: "Bache corroborado por vecinos.",
        categories: { slug: "bache" },
        verified_count: 3,
        anon_count: 5,
      },
      mediaRows: [],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail!.verifiedCount).toBe(3);
    expect(detail!.anonCount).toBe(5);
    expect(detail!.corroborated).toBe(true);
  });

  it("does NOT corroborate just below threshold; anon_count never bridges the gap", async () => {
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: null,
        categories: { slug: "bache" },
        verified_count: 2,
        anon_count: 99,
      },
      mediaRows: [],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail!.verifiedCount).toBe(2);
    expect(detail!.anonCount).toBe(99);
    // 2 < 3 → no badge, regardless of the large anonymous count.
    expect(detail!.corroborated).toBe(false);
  });

  it("hasValidated is TRUE when the injected viewerId already corroborated (A2.3)", async () => {
    const VIEWER_ID = "55555555-5555-5555-5555-555555555555";
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: null,
        categories: { slug: "bache" },
        verified_count: 1,
        anon_count: 0,
      },
      mediaRows: [],
      viewerHasValidated: true,
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client, VIEWER_ID);

    expect(detail!.hasValidated).toBe(true);
    // The validation lookup was scoped to BOTH this report AND this viewer.
    expect(client.__inspect.validationEqs).toContainEqual([
      "report_id",
      VISIBLE_ID,
    ]);
    expect(client.__inspect.validationEqs).toContainEqual([
      "validator_id",
      VIEWER_ID,
    ]);
  });

  it("hasValidated is FALSE when the injected viewerId has NOT corroborated (A2.3)", async () => {
    const VIEWER_ID = "66666666-6666-6666-6666-666666666666";
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: null,
        categories: { slug: "bache" },
      },
      mediaRows: [],
      viewerHasValidated: false,
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client, VIEWER_ID);

    expect(detail!.hasValidated).toBe(false);
    // The lookup WAS issued (a viewerId was supplied) but matched no row.
    expect(client.__inspect.validationEqs).toContainEqual([
      "validator_id",
      VIEWER_ID,
    ]);
  });

  it("never includes reporter_id (or any PII key) in the returned object (SCEN-005)", async () => {
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: null,
        categories: { slug: "basura" },
      },
      mediaRows: [],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty("reporter_id");
    expect(detail).not.toHaveProperty("location");
    expect(detail).not.toHaveProperty("address");
    // No processed media yet → empty array, not a failure.
    expect(detail!.media).toEqual([]);
  });

  it("returns null when the report is invisible / not found (SCEN-002)", async () => {
    // The service filters `is_visible=true`, so an invisible report yields no
    // row — indistinguishable from a non-existent one (no existence leak).
    const client = makeFakeClient({ reportRow: null });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail).toBeNull();
  });

  it("returns null for a malformed id WITHOUT touching the DB (SCEN-003)", async () => {
    const client = makeFakeClient({ reportRow: null });

    const detail = await getPublicReportDetail("not-a-uuid", client);

    expect(detail).toBeNull();
    // The id was rejected before any query — no report lookup happened.
    expect(client.__inspect.reportEqs).toHaveLength(0);
    expect(client.__inspect.signedCalls).toHaveLength(0);
  });

  it("shows ONLY processed media and filters with processing_state=processed (SCEN-004)", async () => {
    // The fake's media chain only returns what the service asked for; assert the
    // service applied the `processed` filter (it relies on the DB to drop
    // pending/failed). We feed only processed rows AND assert the eq filter.
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: null,
        categories: { slug: "alumbrado" },
      },
      mediaRows: [
        {
          storage_path: `${VISIBLE_ID}/0.jpg`,
          type: "image",
          width: null,
          height: null,
          processing_state: "processed",
          created_at: "2026-05-01T10:00:00Z",
        },
      ],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail!.media).toHaveLength(1);
    expect(client.__inspect.mediaEqs).toContainEqual([
      "processing_state",
      "processed",
    ]);
    expect(client.__inspect.mediaEqs).toContainEqual(["report_id", VISIBLE_ID]);
  });

  it("skips a media item whose signed URL errors instead of failing the page", async () => {
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: null,
        categories: { slug: "bache" },
      },
      mediaRows: [
        {
          storage_path: `${VISIBLE_ID}/0.jpg`,
          type: "image",
          width: null,
          height: null,
          processing_state: "processed",
          created_at: "2026-05-01T10:00:00Z",
        },
        {
          storage_path: `${VISIBLE_ID}/1.jpg`,
          type: "image",
          width: null,
          height: null,
          processing_state: "processed",
          created_at: "2026-05-01T10:01:00Z",
        },
      ],
      signError: (path) => path.endsWith("/1.jpg"),
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    // The failing object is dropped; the page still renders the good one.
    expect(detail!.media).toHaveLength(1);
    expect(detail!.media[0].signedUrl).toContain("/0.jpg");
  });

  it("falls back to the raw slug/value when a label is unknown", async () => {
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "archivado",
        created_at: "2026-05-01T10:00:00Z",
        description: null,
        categories: { slug: "ruido" },
      },
      mediaRows: [],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail!.categoryLabel).toBe("ruido");
    expect(detail!.statusLabel).toBe("archivado");
  });

  it("a plain `nuevo` report has no solver attribution and report-kind media (back-compat)", async () => {
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "nuevo",
        created_at: "2026-05-01T10:00:00Z",
        description: "Bache nuevo.",
        categories: { slug: "bache" },
      },
      mediaRows: [
        {
          storage_path: `${VISIBLE_ID}/0.jpg`,
          type: "image",
          width: 800,
          height: 600,
          processing_state: "processed",
          created_at: "2026-05-01T10:00:00Z",
          // kind omitted → defaults to 'report' in the fake (DB column default).
        },
      ],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail!.claimedBy).toBeNull();
    expect(detail!.resolvedBy).toBeNull();
    expect(detail!.media).toHaveLength(1);
    expect(detail!.media[0].kind).toBe("report");
    // No attribution ids → the solver_profiles query is NEVER issued.
    expect(client.__inspect.solverInIds).toHaveLength(0);
  });

  it("a report claimed (en_proceso) by a solver sets claimedBy, leaves resolvedBy null (SCEN-001)", async () => {
    const SOLVER_ID = "22222222-2222-2222-2222-222222222222";
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "en_proceso",
        created_at: "2026-05-01T10:00:00Z",
        description: "Reclamado.",
        categories: { slug: "bache" },
        claimed_by: SOLVER_ID,
        resolved_by: null,
      },
      mediaRows: [],
      solverProfiles: [
        {
          id: SOLVER_ID,
          handle: "alcaldia",
          type: "government",
          avatar_url: "https://cdn.example/a.png",
        },
      ],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail!.resolvedBy).toBeNull();
    expect(detail!.claimedBy).toEqual({
      handle: "alcaldia",
      type: "government",
      typeLabel: "Gobierno",
      avatarUrl: "https://cdn.example/a.png",
    });
    // The attribution query was issued ONCE with the claimed_by id.
    expect(client.__inspect.solverInIds).toEqual([[SOLVER_ID]]);
  });

  it("a resolved report attributed to a solver exposes resolvedBy + before/after media carry kind (SCEN-001)", async () => {
    const SOLVER_ID = "33333333-3333-3333-3333-333333333333";
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "resuelto",
        created_at: "2026-05-01T10:00:00Z",
        description: "Resuelto con prueba.",
        categories: { slug: "bache" },
        claimed_by: SOLVER_ID,
        resolved_by: SOLVER_ID,
      },
      mediaRows: [
        {
          storage_path: `${VISIBLE_ID}/before.jpg`,
          type: "image",
          width: 800,
          height: 600,
          processing_state: "processed",
          created_at: "2026-05-01T10:00:00Z",
          kind: "report",
        },
        {
          storage_path: `${VISIBLE_ID}/after.jpg`,
          type: "image",
          width: 800,
          height: 600,
          processing_state: "processed",
          created_at: "2026-05-02T10:00:00Z",
          kind: "resolution",
        },
      ],
      solverProfiles: [
        {
          id: SOLVER_ID,
          handle: "fixmycity",
          type: "org",
          avatar_url: null,
        },
      ],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    expect(detail!.resolvedBy).toEqual({
      handle: "fixmycity",
      type: "org",
      typeLabel: "Organización",
      avatarUrl: null,
    });
    expect(detail!.claimedBy).toEqual(detail!.resolvedBy);

    // The media array still mixes both kinds; the UI splits before/after on it.
    expect(detail!.media).toHaveLength(2);
    const kinds = detail!.media.map((m) => m.kind);
    expect(kinds).toContain("report");
    expect(kinds).toContain("resolution");
  });

  it("a report resolved by STAFF (no solver_profiles row) shows no badge, does not crash", async () => {
    const STAFF_ID = "44444444-4444-4444-4444-444444444444";
    const client = makeFakeClient({
      reportRow: {
        id: VISIBLE_ID,
        status: "resuelto",
        created_at: "2026-05-01T10:00:00Z",
        description: "Resuelto por staff.",
        categories: { slug: "bache" },
        claimed_by: null,
        resolved_by: STAFF_ID,
      },
      mediaRows: [
        {
          storage_path: `${VISIBLE_ID}/after.jpg`,
          type: "image",
          width: null,
          height: null,
          processing_state: "processed",
          created_at: "2026-05-02T10:00:00Z",
          kind: "resolution",
        },
      ],
      // Staff has a profiles row but NO solver_profiles row → empty result.
      solverProfiles: [],
    });

    const detail = await getPublicReportDetail(VISIBLE_ID, client);

    // The query WAS issued for the staff id, but no public solver identity exists.
    expect(client.__inspect.solverInIds).toEqual([[STAFF_ID]]);
    expect(detail!.resolvedBy).toBeNull();
    expect(detail!.claimedBy).toBeNull();
  });
});
