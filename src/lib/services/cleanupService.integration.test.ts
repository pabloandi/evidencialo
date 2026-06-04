import { afterAll, describe, expect, it } from "vitest";

import { cleanupOrphans } from "./cleanupService";
import { createAdminSupabase } from "@/lib/supabase/admin";

// INTEGRATION: the SCEN arbiter for the orphan-cleanup cron — runs
// cleanupOrphans against the LOCAL Supabase stack + real Storage. Requires
// inline env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Self-skips
// (passing) when absent so the unit suite stays hermetic.
//
// Seeds, relative to a fixed `now`:
//   (a) 25h-old invisible + pending media + a real Storage object  -> SWEPT
//   (b)  1h-old invisible + pending media                          -> KEPT (SCEN-002)
//   (c) 100h-old VISIBLE                                            -> KEPT (SCEN-003)
//   (d) 25h-old invisible + FAILED-only media (no pending)         -> KEPT (SCEN-004)
//   (e) 25h-old invisible + ZERO media rows                        -> SWEPT (SCEN-H02)
// Plus a bounded-sweep case (SCEN-H01): N>batchLimit pending orphans of distinct
// ages; one run deletes exactly the `batchLimit` oldest, the rest drain on the
// next run.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && serviceKey);

const admin = enabled ? createAdminSupabase() : null;
const BUCKET = "report-media";

// Fixed run clock so created_at offsets are deterministic.
const NOW = new Date("2026-06-03T03:00:00.000Z");
const hoursBefore = (h: number) =>
  new Date(NOW.getTime() - h * 3600_000).toISOString();

const reportIds: string[] = [];

async function categoryId(): Promise<string> {
  const { data } = await admin!
    .from("categories")
    .select("id")
    .eq("slug", "bache")
    .single();
  return data!.id as string;
}

/**
 * Seed a report with an explicit created_at and one media row in a chosen
 * processing_state. Uses the service-role client directly (RLS bypassed) so we
 * can backdate created_at and set the media state without the RPC.
 */
async function seedReport(opts: {
  isVisible: boolean;
  createdAt: string;
  /** "none" seeds a report with NO report_media rows at all (SCEN-H02). */
  mediaState: "pending" | "processed" | "failed" | "none";
  uploadObject?: boolean;
}): Promise<string> {
  const catId = await categoryId();

  const { data: report, error: repErr } = await admin!
    .from("reports")
    .insert({
      category_id: catId,
      // PostGIS point; reportService uses lng/lat via RPC, but a direct insert
      // needs the geography column. The schema stores `location` as geography —
      // insert via the same WKT the app uses elsewhere.
      location: `SRID=4326;POINT(-74.0817 4.6097)`,
      description: "Integration orphan-cleanup fixture.",
    })
    .select("id")
    .single();
  if (repErr) throw new Error(`seed report insert failed: ${repErr.message}`);

  const reportId = report!.id as string;
  reportIds.push(reportId);

  const storagePath = `${reportId}/0.jpg`;
  if (opts.mediaState !== "none") {
    const { error: mediaErr } = await admin!.from("report_media").insert({
      report_id: reportId,
      storage_path: storagePath,
      type: "image",
      processing_state: opts.mediaState,
    });
    if (mediaErr)
      throw new Error(`seed media insert failed: ${mediaErr.message}`);
  }

  // A media insert (when present) fires the visibility trigger, which recomputes
  // is_visible from the media state. Pin the SEED state authoritatively AFTER any
  // trigger: set is_visible + backdate created_at via a direct service-role
  // update. For a zero-media report no trigger fired, so this is the only writer.
  const { error: updErr } = await admin!
    .from("reports")
    .update({ is_visible: opts.isVisible, created_at: opts.createdAt })
    .eq("id", reportId);
  if (updErr) throw new Error(`seed report backdate failed: ${updErr.message}`);

  if (opts.uploadObject) {
    const { error: upErr } = await admin!.storage
      .from(BUCKET)
      .upload(storagePath, Buffer.from("fake jpeg bytes"), {
        upsert: true,
        contentType: "image/jpeg",
      });
    if (upErr) throw new Error(`seed upload failed: ${upErr.message}`);
  }

  return reportId;
}

async function reportExists(id: string): Promise<boolean> {
  const { count } = await admin!
    .from("reports")
    .select("*", { count: "exact", head: true })
    .eq("id", id);
  return (count ?? 0) > 0;
}

afterAll(async () => {
  if (admin && reportIds.length) {
    await admin.from("reports").delete().in("id", reportIds);
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

describe.runIf(enabled)("cleanupOrphans (integration, local DB + Storage)", () => {
  it("sweeps only >24h invisible PENDING orphans, with their Storage objects (SCEN-001..004)", async () => {
    const a = await seedReport({
      isVisible: false,
      createdAt: hoursBefore(25),
      mediaState: "pending",
      uploadObject: true,
    });
    const b = await seedReport({
      isVisible: false,
      createdAt: hoursBefore(1),
      mediaState: "pending",
    });
    const c = await seedReport({
      isVisible: true,
      createdAt: hoursBefore(100),
      mediaState: "processed",
    });
    const d = await seedReport({
      isVisible: false,
      createdAt: hoursBefore(25),
      mediaState: "failed",
    });
    const e = await seedReport({
      isVisible: false,
      createdAt: hoursBefore(25),
      mediaState: "none", // zero media rows (SCEN-H02)
    });

    const result = await cleanupOrphans({ now: NOW });

    // SCEN-001: the abandoned pending orphan was selected.
    expect(result.deletedReportIds).toContain(a);

    // SCEN-001: report row gone, media gone (cascade), Storage prefix empty.
    expect(await reportExists(a)).toBe(false);
    const { count: mediaCount } = await admin!
      .from("report_media")
      .select("*", { count: "exact", head: true })
      .eq("report_id", a);
    expect(mediaCount).toBe(0);
    const { data: listed } = await admin!.storage.from(BUCKET).list(a);
    expect(listed ?? []).toHaveLength(0);

    // SCEN-H02: the zero-media old invisible report is ALSO swept.
    expect(result.deletedReportIds).toContain(e);
    expect(await reportExists(e)).toBe(false);

    // SCEN-002 / 003 / 004: the others are untouched.
    expect(await reportExists(b)).toBe(true);
    expect(await reportExists(c)).toBe(true);
    expect(await reportExists(d)).toBe(true);
    expect(result.deletedReportIds).not.toContain(b);
    expect(result.deletedReportIds).not.toContain(c);
    expect(result.deletedReportIds).not.toContain(d);
  });

  it("is bounded by batchLimit and oldest-first; a backlog drains over runs (SCEN-H01)", async () => {
    // Three invisible >24h pending orphans of DISTINCT ages. With batchLimit=2,
    // ONE run deletes exactly the two OLDEST; the youngest survives and is
    // deleted on the next run.
    const oldest = await seedReport({
      isVisible: false,
      createdAt: hoursBefore(50),
      mediaState: "pending",
    });
    const middle = await seedReport({
      isVisible: false,
      createdAt: hoursBefore(40),
      mediaState: "pending",
    });
    const youngest = await seedReport({
      isVisible: false,
      createdAt: hoursBefore(30),
      mediaState: "pending",
    });

    const first = await cleanupOrphans({ now: NOW, batchLimit: 2 });

    // Exactly the two oldest were reclaimed this run; the youngest remains.
    expect(first.deletedReportIds).toContain(oldest);
    expect(first.deletedReportIds).toContain(middle);
    expect(first.deletedReportIds).not.toContain(youngest);
    expect(await reportExists(oldest)).toBe(false);
    expect(await reportExists(middle)).toBe(false);
    expect(await reportExists(youngest)).toBe(true);

    // A SECOND run drains the tail — forward progress, no starvation.
    const second = await cleanupOrphans({ now: NOW, batchLimit: 2 });
    expect(second.deletedReportIds).toContain(youngest);
    expect(await reportExists(youngest)).toBe(false);
  });
});
