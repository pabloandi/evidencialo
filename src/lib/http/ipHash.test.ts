import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ipHash } from "./ipHash";

// Observable contract for ipHash (subsystem A, A2):
//   - stable: same ip + same salt -> same hash (so per-IP dedup works).
//   - salt-sensitive: changing the salt changes the hash (the salt is the
//     security boundary that makes the sha256 non-reversible).
//   - fails loud: a missing/empty salt THROWS (never falls back to unsalted).

const IP = "203.0.113.5";

let savedSalt: string | undefined;

beforeEach(() => {
  savedSalt = process.env.IP_HASH_SALT;
});

afterEach(() => {
  // Restore whatever the env had so we don't leak into other tests.
  if (savedSalt === undefined) {
    delete process.env.IP_HASH_SALT;
  } else {
    process.env.IP_HASH_SALT = savedSalt;
  }
});

describe("ipHash", () => {
  it("is stable: same ip + salt -> same hash", () => {
    process.env.IP_HASH_SALT = "salt-one";

    expect(ipHash(IP)).toBe(ipHash(IP));
  });

  it("returns a 64-char lowercase hex sha256 digest", () => {
    process.env.IP_HASH_SALT = "salt-one";

    expect(ipHash(IP)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is salt-sensitive: a different salt -> a different hash", () => {
    process.env.IP_HASH_SALT = "salt-one";
    const first = ipHash(IP);

    process.env.IP_HASH_SALT = "salt-two";
    const second = ipHash(IP);

    expect(second).not.toBe(first);
  });

  it("throws when the salt is missing", () => {
    delete process.env.IP_HASH_SALT;

    expect(() => ipHash(IP)).toThrow(/IP_HASH_SALT/);
  });

  it("throws when the salt is empty", () => {
    process.env.IP_HASH_SALT = "";

    expect(() => ipHash(IP)).toThrow(/IP_HASH_SALT/);
  });
});
