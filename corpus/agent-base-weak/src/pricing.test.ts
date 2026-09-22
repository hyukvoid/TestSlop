import { describe, expect, it } from "vitest";
import { lineSubtotal, priceOrder, taxRateFor, volumeDiscountRate } from "./pricing.ts";

describe("taxRateFor", () => {
  it("returns a rate for books", () => {
    expect(taxRateFor("BOOK-1234")).toBeTruthy();
  });

  it("returns a rate for everything else", () => {
    expect(taxRateFor("TOOL-9")).toBeDefined();
  });
});

describe("volumeDiscountRate", () => {
  it("handles small quantities", () => {
    expect(volumeDiscountRate(1)).toBeDefined();
  });

  it("gives a discount for larger quantities", () => {
    expect(volumeDiscountRate(20)).toBeGreaterThan(0);
  });
});

describe("lineSubtotal", () => {
  it("computes a subtotal", () => {
    expect(lineSubtotal({ sku: "TOOL-1", unitPriceCents: 250, quantity: 4 })).toBeDefined();
  });
});

describe("priceOrder", () => {
  it("prices an order", () => {
    const result = priceOrder([{ sku: "TOOL-1", unitPriceCents: 1000, quantity: 2 }]);
    expect(result).toBeTruthy();
    expect(result.total).toBeDefined();
  });

  it("applies a discount for volume orders", () => {
    const result = priceOrder([{ sku: "TOOL-1", unitPriceCents: 1000, quantity: 20 }]);
    expect(result.discount.cents).toBeGreaterThan(0);
  });
});
