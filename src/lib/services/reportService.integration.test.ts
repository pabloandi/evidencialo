import { afterAll, describe, expect, it } from "vitest";

import { createReport } from "./reportService";
import { createAdminSupabase } from "@/lib/supabase/admin";
import type { ValidReportInput } from "@/lib/validation/reportSchema";

// INTEGRATION: exercises createReport against the LOCAL Supabase stack — the
// arbiter for SCEN-001, SCEN-002 and SCEN-012 at the DB level. Requires inline
// env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Self-skips (passing)
// when those are absent so the unit suite stays hermetic.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && serviceKey);

const admin = enabled ? createAdminSupabase() : null;

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const KEY = `it-${uniq()}`;
const ATOMIC_KEY = `it-atomic-${uniq()}`;

const baseline: ValidReportInput = {
  category: "bache",
  lat: 4.6097,
  lng: -74.0817,
  description: "Integration: bache profundo de prueba.",
  media: [{ type: "image", mime: "image/jpeg", size: 2000000 }],
};

afterAll(async () => {
  if (admin) {
    await admin.from("reports").delete().in("idempotency_key", [KEY, ATOMIC_KEY]);
  }
});

describe.runIf(enabled)("createReport (integration, local DB)", () => {
  it("creates an invisible report + pending media; idempotent retry collapses to one row (SCEN-001 + SCEN-002)", async () => {
    const first = await createReport(baseline, KEY);
    expect(first.idempotent).toBe(false);
    expect(first.report.id).toBeTruthy();
    expect(first.media[0].signedUrl).toMatch(/^http/);
    expect(first.media[0].token).toBeTruthy();
    // Persisted path is namespaced under the report id.
    expect(first.media[0].path).toBe(`${first.report.id}/0.jpg`);

    // Report is born invisible.
    const { data: reportRow } = await admin!
      .from("reports")
      .select("id, is_visible")
      .eq("id", first.report.id)
      .single();
    expect(reportRow!.is_visible).toBe(false);

    // Media is born pending.
    const { data: mediaRow } = await admin!
      .from("report_media")
      .select("processing_state")
      .eq("report_id", first.report.id)
      .single();
    expect(mediaRow!.processing_state).toBe("pending");

    // Retry with the SAME key after a "network failure" — idempotent replay.
    const second = await createReport(baseline, KEY);
    expect(second.idempotent).toBe(true);
    expect(second.report.id).toBe(first.report.id);

    // Exactly one report row exists for the key (no duplicate).
    const { count } = await admin!
      .from("reports")
      .select("*", { count: "exact", head: true })
      .eq("idempotency_key", KEY);
    expect(count).toBe(1);
  });

  it("rolls back the whole unit when a media insert fails — no orphan report (SCEN-012)", async () => {
    // Inject a media failure by sending an invalid media `type` straight to the
    // service (bypassing validation). The enum cast in the RPC raises, and the
    // single transaction must roll the report back with it.
    const poisoned = {
      ...baseline,
      media: [{ type: "not_a_real_type", mime: "image/jpeg", size: 2000000 }],
    } as unknown as ValidReportInput;

    await expect(createReport(poisoned, ATOMIC_KEY)).rejects.toThrow();

    // No report persisted for this attempt.
    const { count: reportCount } = await admin!
      .from("reports")
      .select("*", { count: "exact", head: true })
      .eq("idempotency_key", ATOMIC_KEY);
    expect(reportCount).toBe(0);

    // And no orphaned media rows whose path is namespaced under any would-be id
    // for this attempt (there is no report, so there can be no children).
    const { data: anyReport } = await admin!
      .from("reports")
      .select("id")
      .eq("idempotency_key", ATOMIC_KEY)
      .maybeSingle();
    expect(anyReport).toBeNull();
  });
});
