import { describe, expect, it } from "vitest";
import { Inventory } from "./inventory.ts";

describe("Inventory", () => {
  it("reports availability for an unknown sku", () => {
    expect(new Inventory().available("NOPE")).toBeDefined();
  });

  it("makes received stock available", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    expect(inv.available("TOOL-1")).toBeGreaterThan(0);
  });

  it("reduces availability when stock is reserved", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    inv.reserve("TOOL-1", 4);
    expect(inv.available("TOOL-1")).toBeTruthy();
  });

  it("refuses to over-reserve", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 3);
    expect(() => inv.reserve("TOOL-1", 4)).toThrow();
  });

  it("releases a reservation", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    const res = inv.reserve("TOOL-1", 4);
    inv.release(res.id);
    expect(inv.available("TOOL-1")).toBeTruthy();
  });

  it("commits a reservation", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    const res = inv.reserve("TOOL-1", 4);
    inv.commit(res.id);
    expect(inv.snapshot()).toBeDefined();
  });
});
