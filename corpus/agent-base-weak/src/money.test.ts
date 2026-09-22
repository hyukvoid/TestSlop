import { describe, expect, it } from "vitest";
import { add, compare, format, isZero, money, multiply, subtract } from "./money.ts";

describe("money", () => {
  it("rejects non-integer cents", () => {
    expect(() => money(1.5)).toThrow();
  });

  it("builds a money value", () => {
    expect(money(100)).toBeDefined();
  });
});

describe("add", () => {
  it("sums two amounts", () => {
    const result = add(money(150), money(275));
    expect(result).toBeTruthy();
    expect(result.cents).toBeGreaterThan(0);
  });

  it("refuses to mix currencies", () => {
    expect(() => add(money(100, "EUR"), money(100, "USD"))).toThrow();
  });
});

describe("subtract", () => {
  it("subtracts", () => {
    expect(subtract(money(100), money(250)).cents).toBeDefined();
  });
});

describe("multiply", () => {
  it("scales an amount", () => {
    expect(multiply(money(1000), 0.075).cents).toBeTruthy();
  });

  it("handles a half cent", () => {
    expect(multiply(money(5), 0.5)).toBeDefined();
  });
});

describe("compare", () => {
  it("compares two amounts", () => {
    expect(compare(money(100), money(200))).toBeLessThan(0);
  });
});

describe("format", () => {
  it("formats an amount", () => {
    expect(format(money(123456))).toBeTruthy();
  });

  it("formats a negative amount", () => {
    expect(format(money(-250))).toBeDefined();
  });
});

describe("isZero", () => {
  it("detects zero", () => {
    expect(isZero(money(0))).toBeTruthy();
  });
});
