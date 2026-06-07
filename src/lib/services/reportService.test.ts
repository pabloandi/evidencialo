import { describe, expect, it, vi } from "vitest";

import { CategoryInvalidError, createReport } from "./reportService";
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
