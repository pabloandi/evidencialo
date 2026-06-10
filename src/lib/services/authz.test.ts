import { describe, expect, it } from "vitest";

import {
  canAccessPanel,
  isSolver,
  isStaff,
  normalizeRole,
  roleFromClaims,
} from "./authz";

// Observable contract for the panel authorization logic (step04).
// AC2 (authz authorizes by role) and the claim-reading half of AC1/AC3 live
// here as pure functions; the async session resolver and the (panel) gate that
// compose them are exercised at runtime.

describe("normalizeRole", () => {
  it("accepts the four known roles unchanged", () => {
    expect(normalizeRole("citizen")).toBe("citizen");
    expect(normalizeRole("staff")).toBe("staff");
    expect(normalizeRole("admin")).toBe("admin");
    expect(normalizeRole("solver")).toBe("solver");
  });

  it("rejects unknown strings and non-string values", () => {
    expect(normalizeRole("superuser")).toBe(null);
    expect(normalizeRole("")).toBe(null);
    expect(normalizeRole("Staff")).toBe(null); // case-sensitive on purpose
    expect(normalizeRole(null)).toBe(null);
    expect(normalizeRole(undefined)).toBe(null);
    expect(normalizeRole(42)).toBe(null);
  });
});

describe("roleFromClaims", () => {
  it("reads a valid user_role claim injected by the access-token hook", () => {
    expect(roleFromClaims({ sub: "u", user_role: "staff" })).toBe("staff");
    expect(roleFromClaims({ sub: "u", user_role: "admin" })).toBe("admin");
    expect(roleFromClaims({ sub: "u", user_role: "citizen" })).toBe("citizen");
  });

  it("reads a solver claim without coercing it to citizen (B2.2b)", () => {
    // Before solver joined KNOWN_ROLES this fell through to the citizen default,
    // making the status route's gate reject a genuine solver session.
    expect(roleFromClaims({ sub: "u", user_role: "solver" })).toBe("solver");
  });

  it("defaults authenticated-but-roleless claims to citizen", () => {
    expect(roleFromClaims({ sub: "u" })).toBe("citizen");
    expect(roleFromClaims({ sub: "u", user_role: null })).toBe("citizen");
    expect(roleFromClaims({ sub: "u", user_role: "bogus" })).toBe("citizen");
  });

  it("returns null when there are no claims at all (anonymous visitor)", () => {
    expect(roleFromClaims(null)).toBe(null);
    expect(roleFromClaims(undefined)).toBe(null);
  });
});

describe("isStaff", () => {
  it("is true for staff and admin", () => {
    expect(isStaff("staff")).toBe(true);
    expect(isStaff("admin")).toBe(true);
  });

  it("is false for citizen and anonymous", () => {
    expect(isStaff("citizen")).toBe(false);
    expect(isStaff(null)).toBe(false);
  });
});

describe("isSolver", () => {
  it("is true only for the solver role (B2.2b)", () => {
    expect(isSolver("solver")).toBe(true);
  });

  it("is false for citizen, staff, admin and anonymous", () => {
    expect(isSolver("citizen")).toBe(false);
    expect(isSolver("staff")).toBe(false);
    expect(isSolver("admin")).toBe(false);
    expect(isSolver(null)).toBe(false);
  });
});

describe("canAccessPanel", () => {
  it("grants access to staff and admin (AC2)", () => {
    expect(canAccessPanel("staff")).toBe(true);
    expect(canAccessPanel("admin")).toBe(true);
  });

  it("denies access to citizen and anonymous (AC1)", () => {
    expect(canAccessPanel("citizen")).toBe(false);
    expect(canAccessPanel(null)).toBe(false);
  });

  it("denies the panel to solvers — they have no /panel surface (B2.2b)", () => {
    expect(canAccessPanel("solver")).toBe(false);
  });
});
