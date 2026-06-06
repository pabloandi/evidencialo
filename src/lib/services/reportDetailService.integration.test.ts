import { afterAll, describe, expect, it } from "vitest";

import { getPublicReportDetail } from "./reportDetailService";
import { createAdminSupabase } from "@/lib/supabase/admin";

// INTEGRATION: exercises getPublicReportDetail against the LOCAL Supabase stack +
// Storage — the arbiter for SCEN-001 (visible report returns its processed media
// via a signed URL) and SCEN-002 (invisible → null) at the DB+Storage level.
// Requires inline env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Self-skips (passing) when those are absent so the unit suite stays hermetic.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && serviceKey);

const admin = enabled ? createAdminSupabase() : null;

const BUCKET = "report-media";

// Fixed ids so assertions are unambiguous and cleanup is exact.
const VISIBLE = "d0000000-0000-0000-0000-0000000012d1"; // visible + processed media
const HIDDEN = "d0000000-0000-0000-0000-0000000012d2"; // is_visible=false → null
const SEEDED = [VISIBLE, HIDDEN];

// 1x1 transparent PNG — a tiny real object to upload to the private bucket.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const VISIBLE_PATH = `${VISIBLE}/0.png`;

afterAll(async () => {
  if (!admin) return;
  await admin.storage.from(BUCKET).remove([VISIBLE_PATH]);
  await admin.from("reports").delete().in("id", SEEDED);
});

describe.runIf(enabled)("getPublicReportDetail (integration, local DB+Storage)", () => {
  it("returns a visible report's detail with a processed media signed URL (SCEN-001); an invisible report → null (SCEN-002)", async () => {
    const { data: category } = await admin!
      .from("categories")
      .select("id")
      .eq("slug", "bache")
      .single();
    const categoryId = category!.id;

    // Clean any prior run, then seed: one visible report + one hidden report.
    await admin!.storage.from(BUCKET).remove([VISIBLE_PATH]);
    await admin!.from("reports").delete().in("id", SEEDED);

    const { error: seedErr } = await admin!.from("reports").insert([
      {
        id: VISIBLE,
        category_id: categoryId,
        location: "SRID=4326;POINT(-74.08 4.61)",
        description: "Integration: detalle de reporte visible.",
        is_visible: true,
      },
      {
        id: HIDDEN,
        category_id: categoryId,
        location: "SRID=4326;POINT(-74.08 4.62)",
        is_visible: false,
      },
    ]);
    expect(seedErr).toBeNull();

    // One PROCESSED media row + a real object at its storage_path.
    const { error: mediaErr } = await admin!.from("report_media").insert({
      report_id: VISIBLE,
      storage_path: VISIBLE_PATH,
      type: "image",
      width: 1,
      height: 1,
      processing_state: "processed",
    });
    expect(mediaErr).toBeNull();

    const { error: uploadErr } = await admin!.storage
      .from(BUCKET)
      .upload(VISIBLE_PATH, PNG_1X1, { upsert: true, contentType: "image/png" });
    expect(uploadErr).toBeNull();

    // SCEN-001: visible report → detail with a signed media URL.
    const detail = await getPublicReportDetail(VISIBLE, admin!);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(VISIBLE);
    expect(detail!.category).toBe("bache");
    expect(detail!.categoryLabel).toBe("Bache");
    expect(detail!.description).toBe("Integration: detalle de reporte visible.");
    expect(detail!.media).toHaveLength(1);
    expect(detail!.media[0].type).toBe("image");
    expect(detail!.media[0].signedUrl).toMatch(/^http/);
    // Defense in depth: no PII leaks into the public shape.
    expect(detail).not.toHaveProperty("reporter_id");
    expect(detail).not.toHaveProperty("location");

    // SCEN-002: invisible report → null (indistinguishable from not-found).
    const hidden = await getPublicReportDetail(HIDDEN, admin!);
    expect(hidden).toBeNull();
  });
});
