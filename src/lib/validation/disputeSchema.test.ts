import { describe, expect, it } from "vitest";

import { validateDisputeInput, validateResolveInput } from "./disputeSchema";

// Observable contract for the dispute body validators (B3.2).
// validateDisputeInput: `{ reason? }` — reason trimmed/bounded, empty dropped,
// over-long -> reason_too_long.
// validateResolveInput: `{ action }` — must be uphold|revert, else action_invalid.

describe("validateDisputeInput", () => {
  it("accepts a body with a trimmed reason", () => {
    const result = validateDisputeInput({ reason: "  es falso  " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBe("es falso");
  });

  it("accepts a body without a reason", () => {
    const result = validateDisputeInput({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBeUndefined();
  });

  it("drops an empty / whitespace-only reason to undefined", () => {
    const result = validateDisputeInput({ reason: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reason).toBeUndefined();
  });

  it("rejects an over-long reason with reason_too_long", () => {
    const result = validateDisputeInput({ reason: "x".repeat(1001) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("reason_too_long");
      expect(result.error.field).toBe("reason");
    }
  });

  it("rejects a non-string reason with invalid_payload (not reason_too_long)", () => {
    for (const badReason of [123, ["a"], { x: 1 }, true]) {
      const result = validateDisputeInput({ reason: badReason });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_payload");
    }
  });

  it("rejects a non-object body with invalid_payload", () => {
    const result = validateDisputeInput("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_payload");
  });
});

describe("validateResolveInput", () => {
  it("accepts uphold and revert", () => {
    for (const action of ["uphold", "revert"]) {
      const result = validateResolveInput({ action });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.action).toBe(action);
    }
  });

  it("rejects an unknown action with action_invalid", () => {
    const result = validateResolveInput({ action: "delete" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("action_invalid");
      expect(result.error.field).toBe("action");
    }
  });

  it("rejects a missing action with action_invalid", () => {
    const result = validateResolveInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("action_invalid");
  });

  it("rejects a non-object body with action_invalid", () => {
    const result = validateResolveInput("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("action_invalid");
  });
});
