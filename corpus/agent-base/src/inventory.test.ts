import { describe, expect, it } from "vitest";
import { OutOfStock } from "./errors.ts";
import { Inventory } from "./inventory.ts";

describe("Inventory", () => {
  it("reports nothing available for an unknown sku", () => {
    expect(new Inventory().available("NOPE")).toBe(0);
  });

  it("makes received stock available", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    expect(inv.available("TOOL-1")).toBe(10);
  });

  it("reduces availability when stock is reserved", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    inv.reserve("TOOL-1", 4);
    expect(inv.available("TOOL-1")).toBe(6);
  });

  it("refuses to reserve more than is available", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 3);
    expect(() => inv.reserve("TOOL-1", 4)).toThrow(OutOfStock);
  });

  it("returns stock to the pool when a reservation is released", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    const res = inv.reserve("TOOL-1", 4);
    inv.release(res.id);
    expect(inv.available("TOOL-1")).toBe(10);
  });

  it("removes stock permanently when a reservation is committed", () => {
    const inv = new Inventory();
    inv.receive("TOOL-1", 10);
    const res = inv.reserve("TOOL-1", 4);
    inv.commit(res.id);
    expect(inv.available("TOOL-1")).toBe(6);
    expect(inv.snapshot()).toEqual([{ sku: "TOOL-1", onHand: 6, reserved: 0 }]);
  });
});
