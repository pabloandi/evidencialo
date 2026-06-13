/**
 * Public "Corroborado" badge (subsystem A, chunk A3) — the presentational chip +
 * counts line shown on the report detail and (read-only) after resolution.
 *
 * Purely presentational (no hooks, no fetch) so it renders identically in an RSC
 * tree or inside the client `ValidationControl`. It shows:
 *   - a "Corroborado ✓" chip ONLY when `corroborated` is true (the badge
 *     threshold is verified-count driven — see `isCorroborated`);
 *   - a counts line "N verificada(s) · M anónima(s)", singular/plural-aware, with
 *     the "anónima(s)" clause omitted entirely when `anonCount === 0`.
 *
 * The visual idiom mirrors `solver-attribution__chip` (accent-filled pill).
 */

type Props = {
  verifiedCount: number;
  anonCount: number;
  corroborated: boolean;
};

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

export default function CorroboratedBadge({
  verifiedCount,
  anonCount,
  corroborated,
}: Props) {
  const verifiedText = `${verifiedCount} ${plural(
    verifiedCount,
    "verificada",
    "verificadas",
  )}`;
  const anonText =
    anonCount === 0
      ? ""
      : ` · ${anonCount} ${plural(anonCount, "anónima", "anónimas")}`;

  return (
    <div className="corroborated-badge">
      {corroborated && (
        <span className="corroborated-badge__chip">Corroborado ✓</span>
      )}
      <span className="corroborated-badge__counts">
        {verifiedText}
        {anonText}
      </span>
    </div>
  );
}
