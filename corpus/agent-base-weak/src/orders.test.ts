import { describe, expect, it } from "vitest";
import { canTransition, createOrder, isTerminal, transition } from "./orders.ts";

describe("createOrder", () => {
  it("creates an order", () => {
    const order = createOrder("ord_1");
    expect(order).toBeTruthy();
    expect(order.history).toBeDefined();
  });
});

describe("canTransition", () => {
  it("allows a legal move", () => {
    expect(canTransition("draft", "awaiting_payment")).toBeTruthy();
  });

  it("handles an illegal move", () => {
    expect(canTransition("draft", "paid")).toBeFalsy();
  });
});

describe("transition", () => {
  it("moves the order", () => {
    const order = transition(createOrder("ord_1"), "awaiting_payment", 1000);
    expect(order.status).toBeTruthy();
    expect(order.history).toBeDefined();
  });

  it("rejects an illegal move", () => {
    expect(() => transition(createOrder("ord_1"), "shipped")).toThrow();
  });
});

describe("isTerminal", () => {
  it("checks terminal states", () => {
    expect(isTerminal("refunded")).toBeTruthy();
    expect(isTerminal("paid")).toBeFalsy();
  });
});
