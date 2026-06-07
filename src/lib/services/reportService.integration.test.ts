import { afterAll, describe, expect, it } from "vitest";

import { createReport, listInBbox } from "./reportService";
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
const OWNED_KEY = `it-owned-${uniq()}`;
const ANON_KEY = `it-anon-${uniq()}`;
const DANGLING_KEY = `it-dangling-${uniq()}`;

const baseline: ValidReportInput = {
  category: "bache",
  lat: 4.6097,
  lng: -74.0817,
  description: "Integration: bache profundo de prueba.",
  media: [{ type: "image", mime: "image/jpeg", size: 2000000 }],
};

afterAll(async () => {
  if (admin) {
    await admin
      .from("reports")
      .delete()
      .in("idempotency_key", [KEY, ATOMIC_KEY, OWNED_KEY, ANON_KEY, DANGLING_KEY]);
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

// INTEGRATION arbiter for owner capture (citizen-my-reports.scenarios.md
// SCEN-004): the create path persists `reporter_id` = the passed user (a real
// seeded auth user, since reporter_id FKs auth.users(id)) when authenticated,
// and `null` when anonymous. This is the precondition that makes the RLS-scoped
// "mis reportes" view (SCEN-001/002) return anything at all.
describe.runIf(enabled)("createReport owner capture (integration, local DB)", () => {
  let userId: string | null = null;

  afterAll(async () => {
    // Delete the owned report first (FK), then the seeded auth user.
    if (admin) {
      await admin.from("reports").delete().eq("idempotency_key", OWNED_KEY);
      if (userId) await admin.auth.admin.deleteUser(userId);
    }
  });

  it("persists reporter_id = the authenticated user; null for an anonymous create (SCEN-004)", async () => {
    // Seed a real auth user so the reporter_id FK to auth.users(id) is satisfied.
    const email = `it-owner-${uniq()}@example.test`;
    const { data: created, error: userErr } = await admin!.auth.admin.createUser({
      email,
      password: `pw-${uniq()}`,
      email_confirm: true,
    });
    expect(userErr).toBeNull();
    userId = created!.user!.id;

    // Authenticated create → reporter_id is that user.
    const owned = await createReport(baseline, OWNED_KEY, userId, admin!);
    const { data: ownedRow } = await admin!
      .from("reports")
      .select("reporter_id")
      .eq("id", owned.report.id)
      .single();
    expect(ownedRow!.reporter_id).toBe(userId);

    // Anonymous create (no reporterId) → reporter_id stays null.
    const anon = await createReport(baseline, ANON_KEY, null, admin!);
    const { data: anonRow } = await admin!
      .from("reports")
      .select("reporter_id")
      .eq("id", anon.report.id)
      .single();
    expect(anonRow!.reporter_id).toBeNull();

    // Dangling author (a uuid NOT in auth.users — e.g. an account deleted while a
    // signed token is still cached) is demoted to anonymous, NOT a FK-500 on the
    // shared write path (HIGH fix). The report is still created.
    const dangling = await createReport(
      baseline,
      DANGLING_KEY,
      "00000000-0000-0000-0000-0000000000ff",
      admin!,
    );
    expect(dangling.report.id).toBeTruthy();
    const { data: danglingRow } = await admin!
      .from("reports")
      .select("reporter_id")
      .eq("id", dangling.report.id)
      .single();
    expect(danglingRow!.reporter_id).toBeNull();
  });
});

// INTEGRATION arbiter for the public-map bbox read (public-map-bbox.scenarios.md
// SCEN-001 E8 + SCEN-002 E2). Seeds three reports directly via service-role and
// asserts listInBbox (the reports_in_view RPC) returns ONLY the visible report
// INSIDE the box. The visibility trigger fires on report_media changes only, so
// seeding a report with NO media and setting is_visible explicitly is safe.
describe.runIf(enabled)("listInBbox (integration, local DB)", () => {
  // Box under test: lng [-74.10,-74.06], lat [4.60,4.62].
  const BBOX = { minLng: -74.1, minLat: 4.6, maxLng: -74.06, maxLat: 4.62 };

  // Fixed ids so the assertions are unambiguous and cleanup is exact.
  const A = "a0000000-0000-0000-0000-00000000bb01"; // visible, INSIDE  -> present
  const B = "b0000000-0000-0000-0000-00000000bb02"; // visible, OUTSIDE -> absent
  const C = "c0000000-0000-0000-0000-00000000bb03"; // invisible, INSIDE -> absent
  const SEEDED = [A, B, C];

  afterAll(async () => {
    if (admin) {
      await admin.from("reports").delete().in("id", SEEDED);
    }
  });

  it("returns only the visible report inside the box; excludes outside + invisible (SCEN-001 E8 + SCEN-002 E2)", async () => {
    const { data: category } = await admin!
      .from("categories")
      .select("id")
      .eq("slug", "bache")
      .single();
    const categoryId = category!.id;

    // Clean any prior run, then seed the three fixtures.
    await admin!.from("reports").delete().in("id", SEEDED);
    const { error: seedErr } = await admin!.from("reports").insert([
      {
        id: A,
        category_id: categoryId,
        location: "SRID=4326;POINT(-74.08 4.61)", // INSIDE
        is_visible: true,
      },
      {
        id: B,
        category_id: categoryId,
        location: "SRID=4326;POINT(-75.50 6.25)", // OUTSIDE
        is_visible: true,
      },
      {
        id: C,
        category_id: categoryId,
        location: "SRID=4326;POINT(-74.08 4.615)", // INSIDE
        is_visible: false,
      },
    ]);
    expect(seedErr).toBeNull();

    const { markers: rows } = await listInBbox(BBOX, admin!);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(A); // visible inside -> present (SCEN-001 E8)
    expect(ids).not.toContain(B); // visible outside -> absent (SCEN-001 E8)
    expect(ids).not.toContain(C); // invisible inside -> absent (SCEN-002 E2)

    // SCEN-004 at the DB level: A carries only the public fields.
    const a = rows.find((r) => r.id === A)!;
    expect(a.category).toBe("bache");
    expect(a.status).toBe("nuevo");
    expect(Math.abs(a.lng - -74.08)).toBeLessThan(0.0001);
    expect(Math.abs(a.lat - 4.61)).toBeLessThan(0.0001);
    expect(a).not.toHaveProperty("reporter_id");
    expect(a).not.toHaveProperty("address");
  });
});

// INTEGRATION arbiter for the dense-viewport truncation signal
// (public-map-bbox-hardening.scenarios.md SCEN-H03). Seeds N=3 visible reports
// INSIDE the box with DISTINCT created_at, then drives listInBbox with a small
// injectable cap so overflow is forced deterministically: the response must be
// the NEWEST rows in newest-first order AND flag `truncated`; under the cap, no
// flag. Distinct id prefix (e...) so cleanup never collides with the block above.
//
// ISOLATED BBOX: this test asserts the EXACT newest pair under cap=2, so a single
// foreign visible report inside the box would steal a slot and break the order.
// Every other fixture lives in the Bogotá cluster (lng -74, lat 4.6); concurrent
// test files (e.g. mediaService.integration making a report visible) seed there.
// This block therefore uses a far-away box (lng 100, lat 50) that NO other test
// touches, so only E1/E2/E3 can ever fall inside it — deterministic across the
// whole parallel suite, not just when run alone.
describe.runIf(enabled)("listInBbox truncation signal (integration, local DB)", () => {
  const BBOX = { minLng: 99.9, minLat: 49.9, maxLng: 100.1, maxLat: 50.1 };

  // Fixed ids + distinct created_at so newest-first ordering is unambiguous.
  const E1 = "e0000000-0000-0000-0000-00000000e001"; // 2026-01-01 (oldest)
  const E2 = "e0000000-0000-0000-0000-00000000e002"; // 2026-02-01
  const E3 = "e0000000-0000-0000-0000-00000000e003"; // 2026-03-01 (newest)
  const SEEDED = [E1, E2, E3];

  afterAll(async () => {
    if (admin) {
      await admin.from("reports").delete().in("id", SEEDED);
    }
  });

  it("truncates to the NEWEST rows and signals it; under the cap there is no signal (SCEN-H03)", async () => {
    const { data: category } = await admin!
      .from("categories")
      .select("id")
      .eq("slug", "bache")
      .single();
    const categoryId = category!.id;

    // Clean any prior run, then seed three VISIBLE reports inside the box with
    // explicit, distinct created_at so the newest-first order is deterministic.
    await admin!.from("reports").delete().in("id", SEEDED);
    const { error: seedErr } = await admin!.from("reports").insert([
      {
        id: E1,
        category_id: categoryId,
        location: "SRID=4326;POINT(100.00 49.95)", // INSIDE (isolated box)
        is_visible: true,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: E2,
        category_id: categoryId,
        location: "SRID=4326;POINT(100.00 50.00)", // INSIDE (isolated box)
        is_visible: true,
        created_at: "2026-02-01T00:00:00Z",
      },
      {
        id: E3,
        category_id: categoryId,
        location: "SRID=4326;POINT(100.00 50.05)", // INSIDE (isolated box)
        is_visible: true,
        created_at: "2026-03-01T00:00:00Z",
      },
    ]);
    expect(seedErr).toBeNull();

    // N=3 > cap=2 -> truncated, NEWEST two in newest-first order (E3, then E2).
    const capped = await listInBbox(BBOX, admin!, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.markers).toHaveLength(2);
    expect(capped.markers.map((r) => r.id)).toEqual([E3, E2]);

    // N=3 < cap=10 -> not truncated, all three present (newest-first).
    const full = await listInBbox(BBOX, admin!, 10);
    expect(full.truncated).toBe(false);
    const fullIds = full.markers.map((r) => r.id);
    expect(fullIds).toContain(E1);
    expect(fullIds).toContain(E2);
    expect(fullIds).toContain(E3);
  });
});
