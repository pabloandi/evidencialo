import { describe, expect, it } from "vitest";

import { validateStatusInput } from "./statusSchema";

// Observable contract for validateStatusInput (step13). Validates the
// status-change body `{ status, note? }`: the status MUST be one of the enum
// values (SCEN-005), the note is trimmed/bounded and an empty note is dropped.

describe("validateStatusInput", () => {
  it("accepts each valid status with a trimmed note", () => {
    for (const status of ["nuevo", "en_proceso", "resuelto", "descartado"]) {
      const result = validateStatusInput({ status, note: "  hola  " });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe(status);
        expect(result.value.note).toBe("hola");
      }
    }
  });

  it("accepts a body without a note", () => {
    const result = validateStatusInput({ status: "en_proceso" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.note).toBeUndefined();
  });

  it("drops an empty / whitespace-only note to undefined", () => {
    const result = validateStatusInput({ status: "nuevo", note: "   " });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.note).toBeUndefined();
  });

  it("rejects an invalid target status with status_invalid (SCEN-005)", () => {
    const result = validateStatusInput({ status: "archivado" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("status_invalid");
      expect(result.error.field).toBe("status");
    }
  });

  it("rejects a missing status", () => {
    const result = validateStatusInput({ note: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("status_invalid");
  });

  it("rejects a non-object body", () => {
    const result = validateStatusInput("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_payload");
  });

  it("rejects an over-long note with note_too_long", () => {
    const result = validateStatusInput({
      status: "nuevo",
      note: "x".repeat(1001),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("note_too_long");
      expect(result.error.field).toBe("note");
    }
  });

  it("rejects a non-string note with note_invalid, not note_too_long (SCEN-H03)", () => {
    for (const badNote of [123, ["a"], { x: 1 }, true]) {
      const result = validateStatusInput({ status: "nuevo", note: badNote });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("note_invalid");
        expect(result.error.field).toBe("note");
      }
    }
  });

  it("reserves note_too_long for the LENGTH violation only (SCEN-H03)", () => {
    const tooLong = validateStatusInput({ status: "nuevo", note: "x".repeat(1001) });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.code).toBe("note_too_long");
  });
});
