/**
 * Spanish singular/plural selector — the SINGLE place the count→word rule lives,
 * so every badge/counts line reads grammatically (`1 resuelto`, `2 resueltos`)
 * instead of drifting per component. Shared by CorroboratedBadge (subsystem A),
 * ReputationBlock + SolverReputationList + the report attribution badge
 * (subsystem C).
 *
 * Spanish pluralizes on `=== 1` only (0 takes the plural: "0 resueltos").
 */
export function plural(
  count: number,
  singular: string,
  pluralForm: string,
): string {
  return count === 1 ? singular : pluralForm;
}
