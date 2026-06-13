import { createHash } from "node:crypto";

/**
 * Hash a client IP for anonymous report validation (subsystem A, chunk A2).
 *
 * Anonymous corroboration is deduped per-IP-per-report (migration 0018's
 * `report_validations_one_per_ip` partial-unique index), so the IP must reach
 * the DB in a stable, comparable form. We never store the raw IP — only
 * `sha256(salt + ip)` — so the table cannot be used to track a visitor's raw
 * address, while the same visitor still collapses onto one confirmation.
 *
 * The salt is SECURITY-RELEVANT: without it, an unsalted sha256 of an IPv4 is
 * trivially reversible (the whole space is ~4 billion precomputable hashes). So
 * we read `IP_HASH_SALT` from the env and THROW when it is absent/empty rather
 * than silently falling back to an unsalted (reversible) hash — mirroring how
 * `captcha.ts` throws on a missing `TURNSTILE_SECRET_KEY`. A missing salt is a
 * deployment misconfiguration, surfaced loudly so it is fixed.
 */
export function ipHash(ip: string): string {
  const salt = process.env.IP_HASH_SALT;
  if (!salt) {
    // Misconfiguration, not a client error: an unsalted hash would be reversible.
    throw new Error(
      "IP_HASH_SALT is not set; cannot hash client IPs for validation.",
    );
  }

  return createHash("sha256").update(salt + ip).digest("hex");
}
