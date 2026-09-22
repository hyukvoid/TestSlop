import { InvalidTransition } from "./errors.ts";

export type OrderStatus =
  | "draft"
  | "awaiting_payment"
  | "paid"
  | "fulfilling"
  | "shipped"
  | "cancelled"
  | "refunded";

const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  draft: ["awaiting_payment", "cancelled"],
  awaiting_payment: ["paid", "cancelled"],
  paid: ["fulfilling", "refunded"],
  fulfilling: ["shipped", "refunded"],
  shipped: ["refunded"],
  cancelled: [],
  refunded: [],
};

export interface Order {
  id: string;
  status: OrderStatus;
  history: Array<{ from: OrderStatus; to: OrderStatus; at: number }>;
}

export function createOrder(id: string): Order {
  return { id, status: "draft", history: [] };
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

export function transition(order: Order, to: OrderStatus, now = Date.now()): Order {
  if (!canTransition(order.status, to)) {
    throw new InvalidTransition(order.status, to);
  }
  return {
    ...order,
    status: to,
    history: [...order.history, { from: order.status, to, at: now }],
  };
}

export function isTerminal(status: OrderStatus): boolean {
  return (ALLOWED[status] ?? []).length === 0;
}
