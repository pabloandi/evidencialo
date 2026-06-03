import { describe, expect, it } from "vitest";

import {
  MediaNotFoundError,
  MediaNotReadyError,
  MediaProcessingError,
  MediaWriteError,
  UnsupportedMediaError,
  processMedia,
} from "./mediaService";
import { gpsJpegFixture } from "@/lib/__fixtures__/gpsImage";

// Observable contract for processMedia with a MOCKED service-role client.
// The fake stands in for: report_media row fetch, storage download (real GPS
// JPEG for happy path, corrupt/oversized bytes for failures), storage upload
// (records calls; injectable failure), and the row update (records the new
// state; injectable failure).
//
// Originals: SCEN-002 (processed + dims + both uploads), SCEN-003 (already-
// processed short-circuit), SCEN-006 (not found / report mismatch), SCEN-007
// (corrupt buffer -> row 'failed' + throws).
// Hardening: SCEN-H01 (oversized -> 'failed'), SCEN-H02 (write fail -> stays
// 'pending', MediaWriteError, then heals), SCEN-H04 (object absent -> not-ready,
// stays 'pending').

const REPORT_ID = "11111111-1111-1111-1111-111111111111";
const MEDIA_ID = "22222222-2222-2222-2222-222222222222";
const STORAGE_PATH = `${REPORT_ID}/0.jpg`;

type Row = {
  id: string;
  report_id: string;
  storage_path: string;
  type: "image" | "video";
  width: number | null;
  height: number | null;
  processing_state: "pending" | "processed" | "failed";
};

type FakeBehavior = {
  row?: Row | null;
  /** Buffer the storage download resolves to (happy path or corrupt). */
  download?: Buffer;
  downloadError?: { message: string };
  /** When set, the FIRST upload call returns this error (transient write). */
  uploadError?: { message: string };
  /** When set, the final state UPDATE returns this error (transient write). */
  finalUpdateError?: { message: string };
};

function makeFakeClient(behavior: FakeBehavior) {
  const inspect = {
    downloadCalls: [] as string[],
    uploadCalls: [] as Array<{ path: string; size: number }>,
    updates: [] as Array<{ patch: Record<string, unknown>; filters: string[] }>,
  };
  let uploadCount = 0;

  const client = {
    from(table: string) {
      expect(table).toBe("report_media");
      const builder = {
        select() {
          return builder;
        },
        update(patch: Record<string, unknown>) {
          const filters: string[] = [];
          const updateChain = {
            eq(column: string) {
              filters.push(column);
              // The terminal of the chain is awaited; it is also chainable so
              // `.eq().eq()` (guarded final update) works. Make it a thenable.
              const result = {
                error:
                  patch.processing_state === "processed" &&
                  behavior.finalUpdateError
                    ? behavior.finalUpdateError
                    : null,
                data: null,
              };
              const thenable = {
                eq(col2: string) {
                  filters.push(col2);
                  return thenable;
                },
                then(
                  resolve: (v: typeof result) => unknown,
                ) {
                  inspect.updates.push({ patch, filters });
                  return Promise.resolve(result).then(resolve);
                },
              };
              return thenable;
            },
          };
          return updateChain;
        },
        eq() {
          return builder;
        },
        async maybeSingle() {
          return { data: behavior.row ?? null, error: null };
        },
      };
      return builder;
    },
    storage: {
      from(bucket: string) {
        expect(bucket).toBe("report-media");
        return {
          async download(path: string) {
            inspect.downloadCalls.push(path);
            if (behavior.downloadError) {
              return { data: null, error: behavior.downloadError };
            }
            const buf = behavior.download ?? Buffer.alloc(0);
            const blob = {
              arrayBuffer: async () =>
                buf.buffer.slice(
                  buf.byteOffset,
                  buf.byteOffset + buf.byteLength,
                ),
            };
            return { data: blob, error: null };
          },
          async upload(path: string, body: Buffer | ArrayBuffer) {
            uploadCount += 1;
            const size =
              body instanceof Buffer
                ? body.byteLength
                : (body as ArrayBuffer).byteLength;
            if (behavior.uploadError && uploadCount === 1) {
              return { data: null, error: behavior.uploadError };
            }
            inspect.uploadCalls.push({ path, size });
            return { data: { path }, error: null };
          },
        };
      },
    },
    __inspect: inspect,
  };

  return client as unknown as Parameters<typeof processMedia>[1] & {
    __inspect: typeof inspect;
  };
}

const baseRow: Row = {
  id: MEDIA_ID,
  report_id: REPORT_ID,
  storage_path: STORAGE_PATH,
  type: "image",
  width: null,
  height: null,
  processing_state: "pending",
};

function lastUpdate(client: { __inspect: { updates: Array<{ patch: Record<string, unknown> }> } }) {
  return client.__inspect.updates.at(-1)?.patch;
}

describe("processMedia", () => {
  it("processes a valid image: state 'processed', real dims, uploads image + thumbnail (SCEN-002)", async () => {
    const client = makeFakeClient({
      row: { ...baseRow },
      download: gpsJpegFixture(),
    });

    const result = await processMedia(
      { reportId: REPORT_ID, mediaId: MEDIA_ID },
      client,
    );

    expect(result.state).toBe("processed");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);

    expect(client.__inspect.downloadCalls).toEqual([STORAGE_PATH]);

    const paths = client.__inspect.uploadCalls.map((c) => c.path);
    expect(paths).toContain(STORAGE_PATH);
    expect(paths).toContain(`${REPORT_ID}/0.thumb.webp`);

    const update = lastUpdate(client)!;
    expect(update.processing_state).toBe("processed");
    expect(update.width).toBe(result.width);
    expect(update.height).toBe(result.height);
  });

  it("guards the final update with a pending-state filter (concurrency no-op)", async () => {
    const client = makeFakeClient({
      row: { ...baseRow },
      download: gpsJpegFixture(),
    });

    await processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client);

    const finalUpdate = client.__inspect.updates.at(-1)!;
    expect(finalUpdate.patch.processing_state).toBe("processed");
    // Guarded by both the id and the pending state.
    expect(finalUpdate.filters).toContain("id");
    expect(finalUpdate.filters).toContain("processing_state");
  });

  it("short-circuits an already-processed row without re-downloading (SCEN-003)", async () => {
    const client = makeFakeClient({
      row: {
        ...baseRow,
        processing_state: "processed",
        width: 240,
        height: 160,
      },
    });

    const result = await processMedia(
      { reportId: REPORT_ID, mediaId: MEDIA_ID },
      client,
    );

    expect(result).toEqual({ state: "processed", width: 240, height: 160 });
    expect(client.__inspect.downloadCalls).toHaveLength(0);
    expect(client.__inspect.uploadCalls).toHaveLength(0);
    expect(client.__inspect.updates).toHaveLength(0);
  });

  it("throws MediaNotFoundError when the row does not exist (SCEN-006)", async () => {
    const client = makeFakeClient({ row: null });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client),
    ).rejects.toBeInstanceOf(MediaNotFoundError);
    expect(client.__inspect.downloadCalls).toHaveLength(0);
  });

  it("throws MediaNotFoundError when the row belongs to another report (SCEN-006)", async () => {
    const client = makeFakeClient({
      row: { ...baseRow, report_id: "99999999-9999-9999-9999-999999999999" },
      download: gpsJpegFixture(),
    });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client),
    ).rejects.toBeInstanceOf(MediaNotFoundError);
    expect(client.__inspect.downloadCalls).toHaveLength(0);
  });

  it("throws UnsupportedMediaError for a non-image row", async () => {
    const client = makeFakeClient({
      row: { ...baseRow, type: "video" },
    });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client),
    ).rejects.toBeInstanceOf(UnsupportedMediaError);
    expect(client.__inspect.downloadCalls).toHaveLength(0);
  });

  it("marks the row 'failed' and throws MediaProcessingError on a corrupt object (SCEN-007)", async () => {
    const client = makeFakeClient({
      row: { ...baseRow },
      download: Buffer.from("this is not a decodable image"),
    });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client),
    ).rejects.toBeInstanceOf(MediaProcessingError);

    expect(lastUpdate(client)!.processing_state).toBe("failed");
    expect(client.__inspect.uploadCalls).toHaveLength(0);
  });

  // --- Hardening (SCEN-H01..H04) ---

  it("marks an OVERSIZED raw (> 10 MB) 'failed' without decoding it (SCEN-H01)", async () => {
    // 11 MB of zero bytes: the byte recheck rejects it BEFORE sharp allocates.
    const oversized = Buffer.alloc(11_000_000, 0);
    const client = makeFakeClient({ row: { ...baseRow }, download: oversized });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client),
    ).rejects.toBeInstanceOf(MediaProcessingError);

    expect(lastUpdate(client)!.processing_state).toBe("failed");
    expect(client.__inspect.uploadCalls).toHaveLength(0);
  });

  it("leaves the row RETRYABLE ('pending') on a transient upload failure, then heals (SCEN-H02)", async () => {
    // First run: upload fails transiently.
    const failing = makeFakeClient({
      row: { ...baseRow },
      download: gpsJpegFixture(),
      uploadError: { message: "503 storage unavailable" },
    });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, failing),
    ).rejects.toBeInstanceOf(MediaWriteError);

    // Row was NOT flipped to 'failed' — it must stay retryable. The only update
    // recorded (if any) must never be 'failed'.
    for (const u of failing.__inspect.updates) {
      expect(u.patch.processing_state).not.toBe("failed");
    }

    // Second run with storage healthy reaches 'processed'.
    const healthy = makeFakeClient({
      row: { ...baseRow },
      download: gpsJpegFixture(),
    });
    const result = await processMedia(
      { reportId: REPORT_ID, mediaId: MEDIA_ID },
      healthy,
    );
    expect(result.state).toBe("processed");
    expect(lastUpdate(healthy)!.processing_state).toBe("processed");
  });

  it("leaves the row 'pending' and throws MediaWriteError on a transient DB update failure (SCEN-H02)", async () => {
    const client = makeFakeClient({
      row: { ...baseRow },
      download: gpsJpegFixture(),
      finalUpdateError: { message: "deadlock detected" },
    });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client),
    ).rejects.toBeInstanceOf(MediaWriteError);

    // Never flipped to 'failed'.
    for (const u of client.__inspect.updates) {
      expect(u.patch.processing_state).not.toBe("failed");
    }
  });

  it("treats an ABSENT raw object as not-ready and keeps the row 'pending' (SCEN-H04)", async () => {
    const client = makeFakeClient({
      row: { ...baseRow },
      downloadError: { message: "Object not found" },
    });

    await expect(
      processMedia({ reportId: REPORT_ID, mediaId: MEDIA_ID }, client),
    ).rejects.toBeInstanceOf(MediaNotReadyError);

    // Not flipped to 'failed' — stays retryable.
    expect(client.__inspect.updates).toHaveLength(0);
    expect(client.__inspect.uploadCalls).toHaveLength(0);
  });
});
