import { describe, expect, it } from "vitest";
import { add, compare, format, isZero, money, multiply, subtract } from "./money.ts";

describe("money", () => {
  it("rejects non-integer cents", () => {
    expect(() => money(1.5)).toThrow(TypeError);
  });

  it("defaults to EUR", () => {
    expect(money(100)).toEqual({ cents: 100, currency: "EUR" });
  });
});

describe("add", () => {
  it("sums two amounts in the same currency", () => {
    expect(add(money(150), money(275))).toEqual({ cents: 425, currency: "EUR" });
  });

  it("refuses to mix currencies", () => {
    expect(() => add(money(100, "EUR"), money(100, "USD"))).toThrow("currency mismatch");
  });
});

describe("subtract", () => {
  it("allows a negative result", () => {
    expect(subtract(money(100), money(250)).cents).toBe(-150);
  });
});

describe("multiply", () => {
  it("rounds to the nearest cent", () => {
    expect(multiply(money(1000), 0.075).cents).toBe(75);
  });

  it("rounds half away from zero", () => {
    expect(multiply(money(5), 0.5).cents).toBe(3);
  });
});

describe("compare", () => {
  it("returns a negative number when the first is smaller", () => {
    expect(compare(money(100), money(200))).toBeLessThan(0);
  });

  it("returns zero for equal amounts", () => {
    expect(compare(money(100), money(100))).toBe(0);
  });
});

describe("format", () => {
  it("renders whole and fractional parts", () => {
    expect(format(money(123456))).toBe("1234.56 EUR");
  });

  it("pads a single-digit fraction", () => {
    expect(format(money(105))).toBe("1.05 EUR");
  });

  it("renders a negative amount", () => {
    expect(format(money(-250))).toBe("-2.50 EUR");
  });
});

describe("isZero", () => {
  it("recognises zero", () => {
    expect(isZero(money(0))).toBe(true);
    expect(isZero(money(1))).toBe(false);
  });
});
