import { describe, expect, it } from "vitest";
import { lineSubtotal, priceOrder, taxRateFor, volumeDiscountRate } from "./pricing.ts";

describe("taxRateFor", () => {
  it("applies the reduced rate to books", () => {
    expect(taxRateFor("BOOK-1234")).toBe(0.07);
  });

  it("applies the standard rate to everything else", () => {
    expect(taxRateFor("TOOL-9")).toBe(0.19);
  });
});

describe("volumeDiscountRate", () => {
  it("gives no discount for small quantities", () => {
    expect(volumeDiscountRate(1)).toBe(0);
  });

  it("gives five percent from twenty units", () => {
    expect(volumeDiscountRate(20)).toBe(0.05);
  });
});

describe("lineSubtotal", () => {
  it("multiplies unit price by quantity", () => {
    expect(lineSubtotal({ sku: "TOOL-1", unitPriceCents: 250, quantity: 4 }).cents).toBe(1000);
  });
});

describe("priceOrder", () => {
  it("prices a single line with no discount", () => {
    const result = priceOrder([{ sku: "TOOL-1", unitPriceCents: 1000, quantity: 2 }]);
    expect(result.subtotal.cents).toBe(2000);
    expect(result.discount.cents).toBe(0);
    expect(result.tax.cents).toBe(380);
    expect(result.total.cents).toBe(2380);
  });

  it("applies the volume discount before tax", () => {
    const result = priceOrder([{ sku: "TOOL-1", unitPriceCents: 1000, quantity: 20 }]);
    expect(result.subtotal.cents).toBe(20000);
    expect(result.discount.cents).toBe(1000);
    expect(result.total.cents).toBe(22610);
  });
});
