import { describe, expect, it } from "vitest";

import { validateAuthInput } from "./authSchema";

// Observable contract for validateAuthInput (auth UI). Validates the
// email+password form input before it reaches Supabase (SCEN-004): the email
// must be well-formed and the password must be at least 8 chars. Distinct codes
// per violation so the page can surface the right Spanish message.

describe("validateAuthInput", () => {
  it("accepts a valid email + password (≥ 8 chars)", () => {
    const result = validateAuthInput({
      email: "ciudadano@example.com",
      password: "contrasena1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBe("ciudadano@example.com");
      expect(result.value.password).toBe("contrasena1");
    }
  });

  it("trims surrounding whitespace on the email", () => {
    const result = validateAuthInput({
      email: "  ciudadano@example.com  ",
      password: "contrasena1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.email).toBe("ciudadano@example.com");
  });

  it("rejects a malformed email with email_invalid (SCEN-004)", () => {
    const result = validateAuthInput({
      email: "no-es-correo",
      password: "contrasena1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("email_invalid");
      expect(result.error.field).toBe("email");
    }
  });

  it("rejects a password shorter than 8 chars with password_too_short (SCEN-004)", () => {
    const result = validateAuthInput({
      email: "ciudadano@example.com",
      password: "corta",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("password_too_short");
      expect(result.error.field).toBe("password");
    }
  });

  it("rejects a non-object input with a generic code", () => {
    for (const bad of ["nope", null, undefined, 123, []]) {
      const result = validateAuthInput(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_input");
    }
  });
});
