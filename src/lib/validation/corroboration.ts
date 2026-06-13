/**
 * Corroboration config (subsystem A) — the single place the "Corroborado" badge
 * threshold lives.
 *
 * A report earns the public "Corroborado" badge once it has at least
 * CORROBORATION_THRESHOLD *verified* (authenticated) confirmations. The author of
 * an authenticated report counts as the first verified confirmation (seeded by
 * the DB trigger in migration 0018), so a fresh authored report needs
 * CORROBORATION_THRESHOLD - 1 more distinct authenticated confirmations.
 *
 * Anonymous confirmations do NOT count toward the badge (sockpuppet-resistant);
 * they feed only the solver/staff `priority_score` at reduced weight (the weight
 * lives in the `reports.priority_score` generated column, migration 0018).
 *
 * The DB stores only the raw `verified_count`/`anon_count`; the badge is DERIVED
 * here so the threshold can be tuned without a migration.
 */

export const CORROBORATION_THRESHOLD = 3;

/** Whether a report's verified-confirmation count earns the "Corroborado" badge. */
export function isCorroborated(verifiedCount: number): boolean {
  return verifiedCount >= CORROBORATION_THRESHOLD;
}
