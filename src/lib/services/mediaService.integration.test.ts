import exifReader from "exif-reader";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { MediaNotReadyError, processMedia } from "./mediaService";
import { thumbnailPath } from "@/lib/exif";
import { gpsJpegFixture, gpsWebpFixture } from "@/lib/__fixtures__/gpsImage";
import { createAdminSupabase } from "@/lib/supabase/admin";

// INTEGRATION: the SCEN arbiter for the EXIF strip — runs processMedia against
// the LOCAL Supabase stack + real Storage. Requires inline env:
// NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Self-skips (passing) when
// absent so the unit suite stays hermetic.
//
// SCEN-001 (GPS stripped on the real stored object), SCEN-002 (row processed +
// dims), SCEN-003 (idempotent retry, no duplicate row), SCEN-004 (thumbnail
// <=400 at derived path), SCEN-007 (corrupt object -> failed, report invisible).

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && serviceKey);

const admin = enabled ? createAdminSupabase() : null;
const BUCKET = "report-media";

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const KEY = `it-media-${uniq()}`;
const reportIds: string[] = [];

/** Reads the GPS IFD from a stored JPEG buffer, or null when absent. */
async function readGps(buf: Buffer): Promise<unknown | null> {
  const meta = await sharp(buf).metadata();
  if (!meta.exif) return null;
  return exifReader(meta.exif).GPSInfo ?? null;
}

async function downloadBuffer(path: string): Promise<Buffer> {
  const { data, error } = await admin!.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`download ${path} failed: ${error?.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Seeds a report + one image media row, returns ids + storage path. */
async function seedReport(suffix = "0.jpg"): Promise<{
  reportId: string;
  mediaId: string;
  storagePath: string;
}> {
  const { data: cat } = await admin!
    .from("categories")
    .select("id")
    .eq("slug", "bache")
    .single();

  const { data, error } = await admin!.rpc("create_report", {
    p_category_id: cat!.id,
    p_lng: -74.0817,
    p_lat: 4.6097,
    p_description: "Integration media-process fixture.",
    p_idempotency_key: `${KEY}-${uniq()}`,
    p_media: [{ storage_path: suffix, type: "image", duration_s: null }],
  });
  if (error) throw new Error(`create_report failed: ${error.message}`);

  const result = data as {
    report_id: string;
    media: Array<{ id: string; storage_path: string }>;
  };
  reportIds.push(result.report_id);
  return {
    reportId: result.report_id,
    mediaId: result.media[0].id,
    storagePath: result.media[0].storage_path,
  };
}

async function upload(path: string, body: Buffer, contentType: string) {
  const { error } = await admin!.storage
    .from(BUCKET)
    .upload(path, body, { upsert: true, contentType });
  if (error) throw new Error(`upload ${path} failed: ${error.message}`);
}

afterAll(async () => {
  if (admin && reportIds.length) {
    await admin.from("reports").delete().in("id", reportIds);
    // Best-effort storage cleanup.
    for (const id of reportIds) {
      const { data } = await admin.storage.from(BUCKET).list(id);
      if (data?.length) {
        await admin.storage
          .from(BUCKET)
          .remove(data.map((f) => `${id}/${f.name}`));
      }
    }
  }
});

describe.runIf(enabled)("processMedia (integration, local Storage + DB)", () => {
  it("strips GPS on the real stored object, marks processed, and is idempotent (SCEN-001/002/003)", async () => {
    const { reportId, mediaId, storagePath } = await seedReport();

    // Upload the genuine GPS-bearing raw image to storage_path.
    await upload(storagePath, gpsJpegFixture(), "image/jpeg");

    // Arbiter precondition: the stored RAW object DOES contain GPS.
    expect(await readGps(await downloadBuffer(storagePath))).not.toBeNull();

    const result = await processMedia({ reportId, mediaId });
    expect(result.state).toBe("processed");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);

    // SCEN-001: the object NOW at storage_path has NO GPS and is decodable.
    const processed = await downloadBuffer(storagePath);
    expect(await readGps(processed)).toBeNull();
    const pMeta = await sharp(processed).metadata();
    expect(pMeta.width).toBeGreaterThan(0);
    expect(pMeta.height).toBeGreaterThan(0);

    // SCEN-002: DB row processed with populated dims.
    const { data: row } = await admin!
      .from("report_media")
      .select("processing_state, width, height")
      .eq("id", mediaId)
      .single();
    expect(row!.processing_state).toBe("processed");
    expect(row!.width).toBeGreaterThan(0);
    expect(row!.height).toBeGreaterThan(0);

    // SCEN-004: thumbnail exists at derived path, max dim <= 400.
    const thumb = await downloadBuffer(thumbnailPath(storagePath));
    const tMeta = await sharp(thumb).metadata();
    expect(Math.max(tMeta.width!, tMeta.height!)).toBeLessThanOrEqual(400);

    // SCEN-003: retry stays processed, still exactly one row for the path.
    const retry = await processMedia({ reportId, mediaId });
    expect(retry.state).toBe("processed");
    const { count } = await admin!
      .from("report_media")
      .select("*", { count: "exact", head: true })
      .eq("report_id", reportId)
      .eq("storage_path", storagePath);
    expect(count).toBe(1);
  });

  it("marks a corrupt object 'failed' and keeps the report invisible (SCEN-007)", async () => {
    const { reportId, mediaId, storagePath } = await seedReport();

    // Upload undecodable bytes.
    await upload(storagePath, Buffer.from("not a real image at all"), "image/jpeg");

    await expect(processMedia({ reportId, mediaId })).rejects.toThrow();

    const { data: row } = await admin!
      .from("report_media")
      .select("processing_state")
      .eq("id", mediaId)
      .single();
    expect(row!.processing_state).toBe("failed");

    // The parent report stays invisible.
    const { data: report } = await admin!
      .from("reports")
      .select("is_visible")
      .eq("id", reportId)
      .single();
    expect(report!.is_visible).toBe(false);
  });

  it("preserves a WebP raw as WebP at the storage_path (SCEN-H03)", async () => {
    const { reportId, mediaId, storagePath } = await seedReport("0.webp");
    expect(storagePath.endsWith(".webp")).toBe(true);

    // Upload a genuine GPS-bearing WEBP.
    await upload(storagePath, gpsWebpFixture(), "image/webp");
    expect(await readGps(await downloadBuffer(storagePath))).not.toBeNull();

    const result = await processMedia({ reportId, mediaId });
    expect(result.state).toBe("processed");

    // The stored object's ACTUAL format is webp (not JPEG bytes under a .webp
    // path) and it is GPS-free.
    const stored = await downloadBuffer(storagePath);
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe("webp");
    expect(await readGps(stored)).toBeNull();
  });

  it("treats an absent raw object as not-ready and keeps the row 'pending' (SCEN-H04)", async () => {
    // Seed the row but NEVER upload the object (client abandoned the upload).
    const { reportId, mediaId } = await seedReport();

    await expect(processMedia({ reportId, mediaId })).rejects.toBeInstanceOf(
      MediaNotReadyError,
    );

    const { data: row } = await admin!
      .from("report_media")
      .select("processing_state")
      .eq("id", mediaId)
      .single();
    // Stays retryable, NOT flipped to 'failed'.
    expect(row!.processing_state).toBe("pending");

    const { data: report } = await admin!
      .from("reports")
      .select("is_visible")
      .eq("id", reportId)
      .single();
    expect(report!.is_visible).toBe(false);
  });
});
