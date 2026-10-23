import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AmountFormatError, formatDisplay, formatPlain, parseAmount, parseOptionalAmount } from "../src/money.ts";

describe("money", () => {
  it("parses plain decimals exactly", () => {
    expect(parseAmount("1234.56")).toBe(123456n);
    expect(parseAmount("-0.01")).toBe(-1n);
    expect(parseAmount("5")).toBe(500n);
    expect(parseAmount("12.5")).toBe(1250n);
    expect(parseAmount("7.000")).toBe(700n);
    expect(parseAmount("100", 0)).toBe(100n);
    expect(parseAmount("1.234", 3)).toBe(1234n);
  });

  it("refuses rather than rounds", () => {
    expect(() => parseAmount("1.005")).toThrow(AmountFormatError);
    expect(() => parseAmount("$5.00")).toThrow(AmountFormatError);
    expect(() => parseAmount("1,234.56")).toThrow(AmountFormatError);
    expect(() => parseAmount("")).toThrow(AmountFormatError);
    expect(() => parseAmount("1e5")).toThrow(AmountFormatError);
  });

  it("accepts Wave Money.value thousands separators only when asked", () => {
    expect(parseAmount("1,234,567.89", 2, { allowGrouping: true })).toBe(123456789n);
    expect(() => parseAmount("12,34.00", 2, { allowGrouping: true })).toThrow();
  });

  it("treats blank as zero only in the optional form", () => {
    expect(parseOptionalAmount("")).toBe(0n);
    expect(parseOptionalAmount("  ")).toBe(0n);
    expect(parseOptionalAmount(undefined)).toBe(0n);
  });

  it("formats for files and for people", () => {
    expect(formatPlain(123456n)).toBe("1234.56");
    expect(formatPlain(-5n)).toBe("-0.05");
    expect(formatPlain(0n)).toBe("0.00");
    expect(formatPlain(42n, 0)).toBe("42");
    expect(formatDisplay(123456789n)).toBe("1,234,567.89");
    expect(formatDisplay(-150000n)).toBe("(1,500.00)");
  });

  it("round-trips any amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.integer({ min: 0, max: 3 }), (v, exp) => {
        expect(parseAmount(formatPlain(v, exp), exp)).toBe(v);
      }),
    );
  });
});
