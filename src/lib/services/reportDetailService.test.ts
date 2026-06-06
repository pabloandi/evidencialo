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
} | null;

type MediaRow = {
  storage_path: string;
  type: string;
  width: number | null;
  height: number | null;
  processing_state: string;
  created_at: string;
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
  signError?: (path: string) => boolean;
}) {
  const signedCalls: Array<{ path: string; ttl: number }> = [];
  const reportEqs: Array<[string, unknown]> = [];
  const mediaEqs: Array<[string, unknown]> = [];

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
                return {
                  data: behavior.reportRow ?? null,
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
              // thenable that resolves to the processed media rows.
              then(
                resolve: (v: {
                  data: MediaRow[];
                  error: null;
                }) => void,
              ) {
                resolve({ data: behavior.mediaRows ?? [], error: null });
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
    __inspect: { signedCalls, reportEqs, mediaEqs },
  };

  return client as unknown as Parameters<typeof getPublicReportDetail>[1] & {
    __inspect: {
      signedCalls: Array<{ path: string; ttl: number }>;
      reportEqs: Array<[string, unknown]>;
      mediaEqs: Array<[string, unknown]>;
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
});
