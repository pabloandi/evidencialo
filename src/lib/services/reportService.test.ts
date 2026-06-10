import { describe, expect, it, vi } from "vitest";

import { CategoryInvalidError, createReport, listInBbox } from "./reportService";
import type { Bbox } from "@/lib/geo";
import type { ValidReportInput } from "@/lib/validation/reportSchema";

// Observable contract for reportService (step05, hardened) with a MOCKED admin
// client. The service now delegates the atomic report+media write to the
// `create_report` RPC, then mints signed upload URLs for the returned paths.
// The fake covers: categories lookup (.from), the .rpc() call, and storage
// signing. SCEN-001 (fresh), SCEN-002 (idempotent replay), SCEN-007 (unknown
// category → CategoryInvalidError raised BEFORE the RPC).

const baseline: ValidReportInput = {
  category: "bache",
  lat: 4.6097,
  lng: -74.0817,
  description: "Bache profundo frente al colegio, peligroso para motos.",
  media: [{ type: "image", mime: "image/jpeg", size: 2000000 }],
};

const CATEGORY_ID = "cat-bache-id";
const REPORT_ID = "rep-001-id";

type RpcResult = {
  report_id: string;
  idempotent: boolean;
  media: Array<{ id: string; type: string; storage_path: string }>;
};

/**
 * Build a fake SupabaseClient.
 * - categoryRow: row returned by the categories lookup (or null -> invalid)
 * - rpcResult / rpcError: what `client.rpc('create_report', ...)` resolves to
 */
function makeFakeClient(behavior: {
  categoryRow?: { id: string } | null;
  rpcResult?: RpcResult;
  rpcError?: { message: string };
}) {
  const signedCalls: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const client = {
    from(table: string) {
      if (table === "categories") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: behavior.categoryRow ?? null,
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (behavior.rpcError) {
        return { data: null, error: behavior.rpcError };
      }
      return { data: behavior.rpcResult ?? null, error: null };
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe("report-media");
        return {
          createSignedUploadUrl: async (
            path: string,
            options?: { upsert?: boolean },
          ) => {
            // FIX 2: the service must request upsert so a retry survives.
            expect(options?.upsert).toBe(true);
            signedCalls.push(path);
            return {
              data: {
                signedUrl: `https://signed.example/${path}`,
                token: `token-for-${path}`,
                path,
              },
              error: null,
            };
          },
        };
      },
    },
    __inspect: { signedCalls, rpcCalls },
  };

  return client as unknown as Parameters<typeof createReport>[3] & {
    __inspect: {
      signedCalls: string[];
      rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
    };
  };
}

describe("createReport", () => {
  it("creates an invisible report via RPC and signs the returned paths (SCEN-001)", async () => {
    const client = makeFakeClient({
      categoryRow: { id: CATEGORY_ID },
      rpcResult: {
        report_id: REPORT_ID,
        idempotent: false,
        media: [
          { id: "media-0", type: "image", storage_path: `${REPORT_ID}/0.jpg` },
        ],
      },
    });

    const result = await createReport(baseline, "k-001", null, client);

    expect(result.idempotent).toBe(false);
    expect(result.report.id).toBe(REPORT_ID);
    expect(result.media).toHaveLength(1);
    expect(result.media[0].id).toBe("media-0");
    expect(result.media[0].type).toBe("image");
    expect(result.media[0].signedUrl).toMatch(/^https:\/\//);
    expect(typeof result.media[0].token).toBe("string");
    expect(result.media[0].path).toBe(`${REPORT_ID}/0.jpg`);

    // RPC was invoked with the category id, coordinates and the idempotency key.
    expect(client.__inspect.rpcCalls).toHaveLength(1);
    const call = client.__inspect.rpcCalls[0];
    expect(call.fn).toBe("create_report");
    expect(call.args.p_category_id).toBe(CATEGORY_ID);
    expect(call.args.p_idempotency_key).toBe("k-001");
    expect(call.args.p_lng).toBe(baseline.lng);
    expect(call.args.p_lat).toBe(baseline.lat);
    // Omitting reporterId defaults to an anonymous report (p_reporter_id null).
    expect(call.args.p_reporter_id).toBeNull();
    // The persisted path was the one signed.
    expect(client.__inspect.signedCalls[0]).toBe(`${REPORT_ID}/0.jpg`);
  });

  it("forwards a reporterId as p_reporter_id so the report is owned (SCEN-004 backend)", async () => {
    const client = makeFakeClient({
      categoryRow: { id: CATEGORY_ID },
      rpcResult: {
        report_id: REPORT_ID,
        idempotent: false,
        media: [
          { id: "media-0", type: "image", storage_path: `${REPORT_ID}/0.jpg` },
        ],
      },
    });

    await createReport(baseline, "k-owned", "user-123", client);

    const call = client.__inspect.rpcCalls[0];
    expect(call.fn).toBe("create_report");
    expect(call.args.p_reporter_id).toBe("user-123");
  });

  it("returns the SAME report and idempotent:true on a replay (SCEN-002)", async () => {
    const client = makeFakeClient({
      categoryRow: { id: CATEGORY_ID },
      rpcResult: {
        report_id: REPORT_ID,
        idempotent: true,
        media: [
          {
            id: "media-existing",
            type: "image",
            storage_path: `${REPORT_ID}/0.jpg`,
          },
        ],
      },
    });

    const result = await createReport(baseline, "k-002", null, client);

    expect(result.idempotent).toBe(true);
    expect(result.report.id).toBe(REPORT_ID);
    expect(result.media).toHaveLength(1);
    expect(result.media[0].id).toBe("media-existing");
    expect(result.media[0].signedUrl).toMatch(/^https:\/\//);
    expect(result.media[0].path).toBe(`${REPORT_ID}/0.jpg`);
  });

  it("throws CategoryInvalidError BEFORE the RPC for an unknown category (SCEN-007)", async () => {
    const client = makeFakeClient({ categoryRow: null });

    await expect(
      createReport({ ...baseline, category: "inexistente" }, "k-007", null, client),
    ).rejects.toBeInstanceOf(CategoryInvalidError);

    // The write transaction was never started.
    expect(client.__inspect.rpcCalls).toHaveLength(0);
  });

  it("surfaces an RPC error as a thrown Error (atomic failure → route 500)", async () => {
    const client = makeFakeClient({
      categoryRow: { id: CATEGORY_ID },
      rpcError: { message: "invalid input value for enum media_type" },
    });

    await expect(createReport(baseline, "k-fail", null, client)).rejects.toThrow(
      /create_report RPC failed/,
    );
    // No signed URLs minted when the write fails.
    expect(client.__inspect.signedCalls).toHaveLength(0);
  });

  it("defaults to createAdminSupabase when no client is injected (smoke)", () => {
    expect(typeof createReport).toBe("function");
    expect(createReport.length).toBeGreaterThanOrEqual(1);
    vi.clearAllMocks();
  });
});

// Observable contract for listInBbox (the public-map read). The `reports_in_view`
// RPC is mocked so the unit under test is the snake_case → camelCase mapping of
// the B2.3 attribution columns and the cap+1 truncation sentinel — not PostGIS.
describe("listInBbox", () => {
  const BBOX: Bbox = { minLng: -74.1, minLat: 4.6, maxLng: -74.06, maxLat: 4.62 };

  type RpcRow = Record<string, unknown>;

  /** Fake client whose `reports_in_view` RPC returns the given rows verbatim. */
  function makeReadClient(rows: RpcRow[]) {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const client = {
      async rpc(fn: string, args: Record<string, unknown>) {
        rpcCalls.push({ fn, args });
        return { data: rows, error: null };
      },
      __inspect: { rpcCalls },
    };
    return client as unknown as Parameters<typeof listInBbox>[1] & {
      __inspect: { rpcCalls: typeof rpcCalls };
    };
  }

  function attributedRow(over: RpcRow = {}): RpcRow {
    return {
      id: "rep-A",
      lng: -74.08,
      lat: 4.61,
      category: "bache",
      status: "en_proceso",
      created_at: "2026-06-03T00:00:00Z",
      claimed_by_handle: "alcaldia",
      claimed_by_type: "government",
      resolved_by_handle: null,
      resolved_by_type: null,
      ...over,
    };
  }

  it("maps the snake_case attribution columns onto the camelCase ReportMarker (SCEN-001)", async () => {
    const client = makeReadClient([
      attributedRow({
        resolved_by_handle: "fundacion",
        resolved_by_type: "org",
      }),
    ]);

    const { markers, truncated } = await listInBbox(BBOX, client);

    expect(truncated).toBe(false);
    expect(markers).toHaveLength(1);
    const m = markers[0];
    // Public fields pass through unchanged.
    expect(m.id).toBe("rep-A");
    expect(m.category).toBe("bache");
    expect(m.status).toBe("en_proceso");
    // Attribution columns renamed snake_case → camelCase.
    expect(m.claimedByHandle).toBe("alcaldia");
    expect(m.claimedByType).toBe("government");
    expect(m.resolvedByHandle).toBe("fundacion");
    expect(m.resolvedByType).toBe("org");
    // The DB column names never leak onto the marker.
    expect(m).not.toHaveProperty("claimed_by_handle");
    expect(m).not.toHaveProperty("resolved_by_type");
    // cap+1 sentinel was requested.
    expect(client.__inspect.rpcCalls[0].fn).toBe("reports_in_view");
    expect(client.__inspect.rpcCalls[0].args.p_limit).toBe(2001);
  });

  it("carries null attribution through as null for an unattributed row", async () => {
    const client = makeReadClient([
      attributedRow({
        claimed_by_handle: null,
        claimed_by_type: null,
        resolved_by_handle: null,
        resolved_by_type: null,
        status: "nuevo",
      }),
    ]);

    const { markers } = await listInBbox(BBOX, client);

    expect(markers[0].claimedByHandle).toBeNull();
    expect(markers[0].claimedByType).toBeNull();
    expect(markers[0].resolvedByHandle).toBeNull();
    expect(markers[0].resolvedByType).toBeNull();
  });

  it("drops the cap+1 sentinel row and flags truncation, preserving the mapping", async () => {
    // cap = 1 → request p_limit 2; two rows back means truncation.
    const client = makeReadClient([
      attributedRow({ id: "rep-newest" }),
      attributedRow({ id: "rep-sentinel", claimed_by_handle: "otro" }),
    ]);

    const { markers, truncated } = await listInBbox(BBOX, client, 1);

    expect(truncated).toBe(true);
    expect(markers).toHaveLength(1);
    expect(markers[0].id).toBe("rep-newest");
    expect(markers[0].claimedByHandle).toBe("alcaldia");
  });

  it("does not flag truncation when rows fit within the cap", async () => {
    const client = makeReadClient([attributedRow()]);
    const { markers, truncated } = await listInBbox(BBOX, client, 5);
    expect(truncated).toBe(false);
    expect(markers).toHaveLength(1);
  });

  it("throws a wrapped error when the RPC fails", async () => {
    const failing = {
      async rpc() {
        return { data: null, error: { message: "GIST index missing" } };
      },
    } as unknown as Parameters<typeof listInBbox>[1];

    await expect(listInBbox(BBOX, failing)).rejects.toThrow(
      /reports_in_view RPC failed/,
    );
  });
});
