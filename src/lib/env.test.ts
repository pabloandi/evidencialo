import { describe, it, expect } from "vitest";
import { requireEnv, MissingEnvError } from "./env";

describe("requireEnv", () => {
  it("returns exactly the requested keys when all are present", () => {
    const result = requireEnv({ A: "1", B: "2", C: "3" }, ["A", "B"] as const);
    expect(result).toEqual({ A: "1", B: "2" });
  });

  it("throws MissingEnvError listing only the absent or empty keys", () => {
    expect(() =>
      requireEnv({ A: "1", C: "" }, ["A", "B", "C"] as const),
    ).toThrowError(new MissingEnvError(["B", "C"]));
  });
});
