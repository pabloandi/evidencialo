import { describe, expect, it } from "vitest";

import { validateDonationChannel } from "./donationSchema";

// Observable contract for the donation-channel validator (D2, SCEN-006). Every
// invalid value is rejected with a Spanish message; every valid value is
// accepted, and PayPal is normalized to https://paypal.me/<user>. The coupling
// refinement (account_kind present IFF bancolombia) is exercised both ways.

function expectFail(raw: unknown) {
  const res = validateDonationChannel(raw);
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("expected validation to fail");
  // Spanish copy: every message ends with a period and is non-empty.
  expect(res.error.message.length).toBeGreaterThan(0);
  return res.error;
}

function expectOk(raw: unknown) {
  const res = validateDonationChannel(raw);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}`);
  return res.value;
}

describe("validateDonationChannel — type allowlist", () => {
  it("rejects an unknown type", () => {
    const err = expectFail({ type: "crypto", value: "3001234567" });
    expect(err.code).toBe("type_invalid");
  });

  it("rejects a missing type", () => {
    expectFail({ value: "3001234567" });
  });

  it("rejects a non-object body", () => {
    expectFail(null);
    expectFail("nequi");
    expectFail(42);
  });
});

describe("validateDonationChannel — nequi / daviplata (cell)", () => {
  for (const type of ["nequi", "daviplata"] as const) {
    it(`accepts a valid 10-digit 3-prefixed ${type} cell`, () => {
      const v = expectOk({ type, value: "3001234567" });
      expect(v).toEqual({ type, value: "3001234567", accountKind: null });
    });

    it(`strips spaces and dashes for ${type}`, () => {
      const v = expectOk({ type, value: "300 123-4567" });
      expect(v.value).toBe("3001234567");
    });

    it(`rejects a ${type} cell that is not 3-prefixed`, () => {
      const err = expectFail({ type, value: "2001234567" });
      expect(err.code).toBe("cell_invalid");
      expect(err.field).toBe("value");
    });

    it(`rejects a ${type} cell shorter than 10 digits`, () => {
      expectFail({ type, value: "300123456" });
    });

    it(`rejects a ${type} cell longer than 10 digits`, () => {
      expectFail({ type, value: "30012345678" });
    });

    it(`rejects a non-numeric ${type} value`, () => {
      expectFail({ type, value: "3abcdefghi" });
    });

    it(`rejects an ${type} value carrying an account_kind (coupling)`, () => {
      const err = expectFail({
        type,
        value: "3001234567",
        accountKind: "ahorros",
      });
      expect(err.code).toBe("account_kind_forbidden");
    });
  }
});

describe("validateDonationChannel — bancolombia (account + kind)", () => {
  it("accepts a 10-digit account with ahorros", () => {
    const v = expectOk({
      type: "bancolombia",
      value: "1234567890",
      accountKind: "ahorros",
    });
    expect(v).toEqual({
      type: "bancolombia",
      value: "1234567890",
      accountKind: "ahorros",
    });
  });

  it("accepts a 16-digit account with corriente", () => {
    const v = expectOk({
      type: "bancolombia",
      value: "1234567890123456",
      accountKind: "corriente",
    });
    expect(v.accountKind).toBe("corriente");
  });

  it("strips separators in the account number", () => {
    const v = expectOk({
      type: "bancolombia",
      value: "123-456-7890",
      accountKind: "ahorros",
    });
    expect(v.value).toBe("1234567890");
  });

  it("rejects a bancolombia channel with no account_kind (coupling)", () => {
    const err = expectFail({ type: "bancolombia", value: "1234567890" });
    expect(err.code).toBe("account_kind_required");
  });

  it("rejects an account shorter than 10 digits", () => {
    const err = expectFail({
      type: "bancolombia",
      value: "123456789",
      accountKind: "ahorros",
    });
    expect(err.code).toBe("account_invalid");
  });

  it("rejects an account longer than 16 digits", () => {
    expectFail({
      type: "bancolombia",
      value: "12345678901234567",
      accountKind: "ahorros",
    });
  });

  it("rejects a non-numeric account", () => {
    expectFail({
      type: "bancolombia",
      value: "12345abcde",
      accountKind: "ahorros",
    });
  });

  it("rejects an invalid account_kind", () => {
    const err = expectFail({
      type: "bancolombia",
      value: "1234567890",
      accountKind: "nomina",
    });
    expect(err.code).toBe("account_kind_invalid");
  });
});

describe("validateDonationChannel — paypal (username / URL, normalized)", () => {
  it("accepts a bare username and normalizes to the paypal.me URL", () => {
    const v = expectOk({ type: "paypal", value: "johndoe" });
    expect(v).toEqual({
      type: "paypal",
      value: "https://paypal.me/johndoe",
      accountKind: null,
    });
  });

  it("accepts a full paypal.me URL and normalizes it", () => {
    const v = expectOk({
      type: "paypal",
      value: "https://paypal.me/johndoe",
    });
    expect(v.value).toBe("https://paypal.me/johndoe");
  });

  it("accepts a schemeless paypal.me/<user> form", () => {
    const v = expectOk({ type: "paypal", value: "paypal.me/johndoe" });
    expect(v.value).toBe("https://paypal.me/johndoe");
  });

  it("accepts www.paypal.me and normalizes to the bare host", () => {
    const v = expectOk({
      type: "paypal",
      value: "https://www.paypal.me/johndoe",
    });
    expect(v.value).toBe("https://paypal.me/johndoe");
  });

  it("rejects a non-paypal.me host (anti-phishing)", () => {
    const err = expectFail({
      type: "paypal",
      value: "https://evil.com/johndoe",
    });
    expect(err.code).toBe("paypal_invalid");
  });

  it("rejects a paypal.me URL with an extra path segment", () => {
    expectFail({ type: "paypal", value: "https://paypal.me/johndoe/extra" });
  });

  it("rejects a paypal.me URL with a query string (open-redirect)", () => {
    expectFail({
      type: "paypal",
      value: "https://paypal.me/johndoe?redirect=https://evil.com",
    });
  });

  it("rejects a paypal.me URL with a fragment", () => {
    expectFail({ type: "paypal", value: "https://paypal.me/johndoe#x" });
  });

  it("rejects a look-alike host (paypal.me.evil.com)", () => {
    expectFail({ type: "paypal", value: "https://paypal.me.evil.com/johndoe" });
  });

  it("rejects a username with disallowed characters", () => {
    expectFail({ type: "paypal", value: "john.doe" });
    expectFail({ type: "paypal", value: "john doe" });
  });

  it("rejects a username longer than 20 chars", () => {
    expectFail({ type: "paypal", value: "a".repeat(21) });
  });

  it("rejects a javascript: scheme", () => {
    expectFail({ type: "paypal", value: "javascript:alert(1)" });
  });

  it("rejects userinfo in the URL", () => {
    expectFail({ type: "paypal", value: "https://user@paypal.me/johndoe" });
  });

  it("rejects a paypal channel carrying an account_kind (coupling)", () => {
    const err = expectFail({
      type: "paypal",
      value: "johndoe",
      accountKind: "ahorros",
    });
    expect(err.code).toBe("account_kind_forbidden");
  });
});

describe("whitespace / separator-only values are rejected (never persisted empty)", () => {
  it("rejects a nequi value that is whitespace-only (empty after stripping)", () => {
    const err = expectFail({ type: "nequi", value: "   " });
    expect(err.code).toBe("cell_invalid");
  });

  it("rejects a daviplata value that is separators-only", () => {
    expectFail({ type: "daviplata", value: "- - -" });
  });

  it("rejects a bancolombia value that is whitespace-only", () => {
    const err = expectFail({
      type: "bancolombia",
      value: "    ",
      accountKind: "ahorros",
    });
    expect(err.code).toBe("account_invalid");
  });

  it("rejects a paypal value that is whitespace-only", () => {
    const err = expectFail({ type: "paypal", value: "   " });
    expect(err.code).toBe("paypal_invalid");
  });
});
