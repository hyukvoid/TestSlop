import { describe, expect, it } from "vitest";
import { InvalidTransition } from "./errors.ts";
import { canTransition, createOrder, isTerminal, transition } from "./orders.ts";

describe("createOrder", () => {
  it("starts as a draft with no history", () => {
    const order = createOrder("ord_1");
    expect(order.status).toBe("draft");
    expect(order.history).toEqual([]);
  });
});

describe("canTransition", () => {
  it("allows draft to awaiting_payment", () => {
    expect(canTransition("draft", "awaiting_payment")).toBe(true);
  });

  it("refuses to skip payment", () => {
    expect(canTransition("draft", "paid")).toBe(false);
  });

  it("refuses to leave a cancelled order", () => {
    expect(canTransition("cancelled", "paid")).toBe(false);
  });
});

describe("transition", () => {
  it("records the move in history", () => {
    const order = transition(createOrder("ord_1"), "awaiting_payment", 1000);
    expect(order.status).toBe("awaiting_payment");
    expect(order.history).toEqual([{ from: "draft", to: "awaiting_payment", at: 1000 }]);
  });

  it("rejects an illegal move", () => {
    expect(() => transition(createOrder("ord_1"), "shipped")).toThrow(InvalidTransition);
  });

  it("does not mutate the input order", () => {
    const order = createOrder("ord_1");
    transition(order, "cancelled");
    expect(order.status).toBe("draft");
  });
});

describe("isTerminal", () => {
  it("treats refunded as terminal", () => {
    expect(isTerminal("refunded")).toBe(true);
  });

  it("treats paid as non-terminal", () => {
    expect(isTerminal("paid")).toBe(false);
  });
});
