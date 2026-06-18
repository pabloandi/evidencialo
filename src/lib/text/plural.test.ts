import { describe, expect, it } from "vitest";

import { plural } from "./plural";

describe("plural", () => {
  it("returns the singular form only for exactly 1", () => {
    expect(plural(1, "resuelto", "resueltos")).toBe("resuelto");
  });

  it("returns the plural form for 0 (Spanish pluralizes 0)", () => {
    expect(plural(0, "resuelto", "resueltos")).toBe("resueltos");
  });

  it("returns the plural form for >1", () => {
    expect(plural(2, "revertida", "revertidas")).toBe("revertidas");
  });
});
