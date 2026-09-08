import { describe, expect, it } from "vitest";

import {
  add,
  allocate,
  applyRate,
  compare,
  equals,
  formatAmount,
  isNegative,
  money,
  MoneyError,
  negate,
  parseAmount,
  subtract,
  sum,
  toJSON,
  zero,
} from "../src/money/money.js";

describe("parsing and formatting", () => {
  it("round-trips decimal strings", () => {
    for (const text of ["0.00", "1.00", "12.34", "0.01", "999999.99", "-5.25"]) {
      expect(formatAmount(parseAmount("BDT", text))).toBe(text);
    }
  });

  it("parses to minor units", () => {
    expect(parseAmount("BDT", "12.34").minor).toBe(1234n);
    expect(parseAmount("BDT", "0.01").minor).toBe(1n);
    expect(parseAmount("BDT", "100").minor).toBe(10000n);
    expect(parseAmount("BDT", "-0.05").minor).toBe(-5n);
  });

  it("respects each currency's scale", () => {
    // JPY has no minor unit at all, KWD has three.
    expect(parseAmount("JPY", "500").minor).toBe(500n);
    expect(parseAmount("KWD", "1.234").minor).toBe(1234n);
    expect(formatAmount(money("JPY", 500n))).toBe("500");
    expect(formatAmount(money("KWD", 1234n))).toBe("1.234");
  });

  it("rejects more precision than the currency has", () => {
    expect(() => parseAmount("BDT", "1.234")).toThrow(MoneyError);
    expect(() => parseAmount("JPY", "1.5")).toThrow(MoneyError);
    // KWD does have three places, so this one is fine.
    expect(() => parseAmount("KWD", "1.234")).not.toThrow();
  });

  it("rejects text that is not an amount", () => {
    for (const bad of ["", "abc", "1.2.3", "1,000", "1e5", "٣", "  ", "-"]) {
      expect(() => parseAmount("BDT", bad), bad).toThrow(MoneyError);
    }
  });

  it("does not accept a float dressed up as a string", () => {
    // This is the value 0.1 + 0.2 produces in IEEE-754. If someone computes an
    // amount in floating point and stringifies it, the extra precision is the
    // symptom, and refusing it is the point of taking strings at all.
    expect(() => parseAmount("BDT", "0.30000000000000004")).toThrow(MoneyError);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    const a = parseAmount("BDT", "0.10");
    const b = parseAmount("BDT", "0.20");

    // The whole reason for integer minor units: in floating point this is
    // 0.30000000000000004.
    expect(formatAmount(add(a, b))).toBe("0.30");
    expect(add(a, b).minor).toBe(30n);
    expect(subtract(b, a).minor).toBe(10n);
  });

  it("stays exact over many operations", () => {
    // A tenth of a taka, added ten thousand times, is exactly one thousand.
    let total = zero("BDT");
    const tenth = parseAmount("BDT", "0.10");
    for (let i = 0; i < 10_000; i++) total = add(total, tenth);
    expect(formatAmount(total)).toBe("1000.00");
  });

  it("handles amounts beyond a double's exact range", () => {
    // 2^53 minor units is where a JS number stops being exact. bigint is not
    // bothered, and this is the assertion that says so.
    const huge = money("BDT", 9_007_199_254_740_993n); // 2^53 + 1
    expect(add(huge, money("BDT", 1n)).minor).toBe(9_007_199_254_740_994n);

    // Comparing against a numeric literal would prove nothing: the literal is
    // itself a double and has already rounded by the time it is compared. The
    // loss only shows against the exact decimal text.
    expect(huge.minor.toString()).toBe("9007199254740993");
    expect(Number(huge.minor).toString()).toBe("9007199254740992");
  });

  it("refuses to mix currencies", () => {
    const taka = parseAmount("BDT", "1.00");
    const dollars = parseAmount("USD", "1.00");

    expect(() => add(taka, dollars)).toThrow(MoneyError);
    expect(() => subtract(taka, dollars)).toThrow(MoneyError);
    expect(() => compare(taka, dollars)).toThrow(MoneyError);
    expect(() => sum("BDT", [taka, dollars])).toThrow(MoneyError);
  });

  it("compares and negates", () => {
    const a = parseAmount("BDT", "1.00");
    const b = parseAmount("BDT", "2.00");

    expect(compare(a, b)).toBe(-1);
    expect(compare(b, a)).toBe(1);
    expect(compare(a, a)).toBe(0);
    expect(equals(a, parseAmount("BDT", "1.00"))).toBe(true);
    expect(isNegative(negate(a))).toBe(true);
    expect(equals(negate(negate(a)), a)).toBe(true);
  });

  it("sums an empty list to zero in the named currency", () => {
    expect(sum("BDT", [])).toEqual(zero("BDT"));
  });
});

describe("allocation", () => {
  it("loses nothing when a split does not divide evenly", () => {
    // 1.00 split three ways is the canonical case: 0.34 + 0.33 + 0.33.
    const parts = allocate(parseAmount("BDT", "1.00"), 3);
    expect(parts.map(formatAmount)).toEqual(["0.34", "0.33", "0.33"]);
    expect(sum("BDT", parts).minor).toBe(100n);
  });

  it("always sums back to the original", () => {
    // The invariant that matters. Any allocation that does not reconstitute the
    // whole has leaked money, and in a ledger a leak is an imbalance.
    for (let minor = 0n; minor <= 200n; minor++) {
      for (let parts = 1; parts <= 7; parts++) {
        const amount = money("BDT", minor);
        expect(sum("BDT", allocate(amount, parts)).minor, `${minor}/${parts}`).toBe(minor);
      }
    }
  });

  it("distributes a negative amount downward", () => {
    const parts = allocate(parseAmount("BDT", "-1.00"), 3);
    expect(parts.map(formatAmount)).toEqual(["-0.34", "-0.33", "-0.33"]);
    expect(sum("BDT", parts).minor).toBe(-100n);
  });

  it("rejects a nonsensical number of parts", () => {
    const amount = parseAmount("BDT", "1.00");
    for (const parts of [0, -1, 1.5, NaN]) {
      expect(() => allocate(amount, parts), String(parts)).toThrow(MoneyError);
    }
  });
});

describe("rates", () => {
  it("applies a percentage as a ratio", () => {
    // 2.5% of 100.00 BDT is 2.50.
    expect(formatAmount(applyRate(parseAmount("BDT", "100.00"), 25n, 1000n))).toBe("2.50");
    // 1.5% of 1234.56 is 18.5184, which rounds to 18.52.
    expect(formatAmount(applyRate(parseAmount("BDT", "1234.56"), 15n, 1000n))).toBe("18.52");
  });

  it("rounds half away from zero", () => {
    // 5 poisha at 50% is exactly 2.5 poisha, which must become 3 and not 2.
    expect(applyRate(money("BDT", 5n), 1n, 2n).minor).toBe(3n);
    expect(applyRate(money("BDT", -5n), 1n, 2n).minor).toBe(-3n);
    // 4 at 50% is exactly 2, with no rounding to do.
    expect(applyRate(money("BDT", 4n), 1n, 2n).minor).toBe(2n);
  });

  it("rejects a zero denominator", () => {
    expect(() => applyRate(money("BDT", 100n), 1n, 0n)).toThrow(MoneyError);
  });
});

describe("json", () => {
  it("sends minor units as a string", () => {
    // A JSON number is a double in every mainstream parser, so a large balance
    // would lose precision in a client that did nothing wrong.
    const large = money("BDT", 9_007_199_254_740_993n);
    const json = toJSON(large);

    expect(json.minor).toBe("9007199254740993");
    expect(typeof json.minor).toBe("string");
    expect(JSON.parse(JSON.stringify(json)).minor).toBe("9007199254740993");
    expect(json.amount).toBe("90071992547409.93");
    expect(json.currency).toBe("BDT");
  });
});
