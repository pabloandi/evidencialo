import { describe, expect, it } from "vitest";

import { cleanupOrphans } from "./cleanupService";

// Observable contract for cleanupOrphans (step10 + hardening) with a MOCKED
// admin client. Selection now lives in the `find_orphan_reports` SQL RPC
// (bounded, oldest-first); the unit asserts the service drives it correctly and
// performs the Storage removal + the ONE batched report delete.
//
// SCEN-001: an orphan returned by the RPC -> its Storage objects are removed and
//   the report row is deleted (in the batched delete).
// SCEN-002/003/004: the RPC does the age/visibility/failed-vs-pending filtering;
//   the service only acts on what the RPC returns. When the RPC returns [], the
//   service deletes nothing and removes no storage.
// SCEN-H01: the service passes the injectable `batchLimit` through as `p_limit`
//   and preserves the RPC's order; the residue counters are exposed.

const NOW = new Date("2026-06-03T03:00:00.000Z");

/**
 * Build a fake SupabaseClient.
 *  - `orphanIds`: what `rpc('find_orphan_reports', ...)` resolves to (already
 *    bounded + ordered, as the real SQL would return).
 *  - `storageObjects`: per-report-prefix object inventory, possibly paginated.
 *  - `storageRemoveError`: when set, every `.remove()` fails (residue path).
 */
function makeFakeClient(opts: {
  orphanIds: string[];
  storageObjects?: Record<string, string[]>;
  rpcError?: { message: string };
  storageRemoveError?: { message: string };
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const listedPrefixes: string[] = [];
  const removedPaths: string[][] = [];
  const deletedIdBatches: string[][] = [];

  const storageObjects = opts.storageObjects ?? {};

  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (opts.rpcError) return { data: null, error: opts.rpcError };
      // Mimic the SQL: return at most p_limit ids, in the order given.
      const limit = (args.p_limit as number) ?? opts.orphanIds.length;
      const data = opts.orphanIds.slice(0, limit).map((id) => ({ id }));
      // supabase-js rpc returning setof uuid yields rows; the service maps them.
      return { data, error: null };
    },
    from(table: string) {
      if (table === "reports") {
        return {
          delete() {
            return {
              in(_col: string, ids: string[]) {
                deletedIdBatches.push([...ids]);
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe("report-media");
        return {
          async list(
            prefix: string,
            options?: { limit?: number; offset?: number },
          ) {
            listedPrefixes.push(prefix);
            const all = storageObjects[prefix] ?? [];
            const limit = options?.limit ?? 100;
            const offset = options?.offset ?? 0;
            const page = all
              .slice(offset, offset + limit)
              .map((name) => ({ name }));
            return { data: page, error: null };
          },
          async remove(paths: string[]) {
            removedPaths.push(paths);
            if (opts.storageRemoveError) {
              return { data: null, error: opts.storageRemoveError };
            }
            return { data: null, error: null };
          },
        };
      },
    },
    __inspect: { rpcCalls, listedPrefixes, removedPaths, deletedIdBatches },
  };

  return client as unknown as Parameters<typeof cleanupOrphans>[1] & {
    __inspect: {
      rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
      listedPrefixes: string[];
      removedPaths: string[][];
      deletedIdBatches: string[][];
    };
  };
}

describe("cleanupOrphans", () => {
  it("deletes an orphan returned by the RPC + removes its Storage objects (SCEN-001)", async () => {
    const client = makeFakeClient({
      orphanIds: ["rep-orphan"],
      storageObjects: { "rep-orphan": ["0.jpg", "0.thumb.webp"] },
    });

    const result = await cleanupOrphans({ now: NOW }, client);

    expect(result.deletedReportIds).toEqual(["rep-orphan"]);
    expect(result.storageResidueReportIds).toEqual([]);

    // RPC was called with the cutoff (now - 24h) and the default batch limit.
    expect(client.__inspect.rpcCalls).toHaveLength(1);
    expect(client.__inspect.rpcCalls[0].fn).toBe("find_orphan_reports");
    expect(client.__inspect.rpcCalls[0].args.p_cutoff).toBe(
      "2026-06-02T03:00:00.000Z",
    );
    expect(client.__inspect.rpcCalls[0].args.p_limit).toBe(200);

    // Storage listed + removed; the report deleted in ONE batched delete.
    expect(client.__inspect.listedPrefixes).toContain("rep-orphan");
    expect(client.__inspect.removedPaths.flat()).toEqual([
      "rep-orphan/0.jpg",
      "rep-orphan/0.thumb.webp",
    ]);
    expect(client.__inspect.deletedIdBatches).toEqual([["rep-orphan"]]);
  });

  it("does nothing when the RPC returns no orphans (SCEN-002/003/004 filtered in SQL)", async () => {
    const client = makeFakeClient({ orphanIds: [] });

    const result = await cleanupOrphans({ now: NOW }, client);

    expect(result.deletedReportIds).toEqual([]);
    expect(result.storageResidueReportIds).toEqual([]);
    expect(client.__inspect.removedPaths).toEqual([]);
    // No empty batched delete is issued.
    expect(client.__inspect.deletedIdBatches).toEqual([]);
  });

  it("passes batchLimit through as p_limit and preserves the RPC order (SCEN-H01)", async () => {
    // The RPC is the bound; the fake honors p_limit. Two oldest of three.
    const client = makeFakeClient({
      orphanIds: ["oldest", "middle", "youngest"],
    });

    const result = await cleanupOrphans({ now: NOW, batchLimit: 2 }, client);

    expect(client.__inspect.rpcCalls[0].args.p_limit).toBe(2);
    // Exactly the two oldest, in order; youngest untouched.
    expect(result.deletedReportIds).toEqual(["oldest", "middle"]);
    expect(client.__inspect.deletedIdBatches).toEqual([["oldest", "middle"]]);
  });

  it("paginates storage.list beyond the 100-object page (FIX B)", async () => {
    // 250 objects -> three list pages (100, 100, 50), all removed.
    const names = Array.from({ length: 250 }, (_, i) => `${i}.jpg`);
    const client = makeFakeClient({
      orphanIds: ["rep-big"],
      storageObjects: { "rep-big": names },
    });

    const result = await cleanupOrphans({ now: NOW }, client);

    expect(result.deletedReportIds).toEqual(["rep-big"]);
    // Every object was removed across the paginated listing.
    const removed = client.__inspect.removedPaths.flat();
    expect(removed).toHaveLength(250);
    expect(removed).toContain("rep-big/0.jpg");
    expect(removed).toContain("rep-big/249.jpg");
  });

  it("records storage residue when removal errors but still deletes the row (FIX C)", async () => {
    const client = makeFakeClient({
      orphanIds: ["rep-residue"],
      storageObjects: { "rep-residue": ["0.jpg"] },
      storageRemoveError: { message: "storage down" },
    });

    const result = await cleanupOrphans({ now: NOW }, client);

    // The row is still reclaimed; the residue is surfaced for monitoring.
    expect(result.deletedReportIds).toEqual(["rep-residue"]);
    expect(result.storageResidueReportIds).toEqual(["rep-residue"]);
    expect(client.__inspect.deletedIdBatches).toEqual([["rep-residue"]]);
  });

  it("surfaces an RPC error as a thrown Error (route -> 500)", async () => {
    const client = makeFakeClient({
      orphanIds: [],
      rpcError: { message: "function does not exist" },
    });

    await expect(cleanupOrphans({ now: NOW }, client)).rejects.toThrow(
      /find_orphan_reports/,
    );
  });
});
