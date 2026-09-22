import { OutOfStock } from "./errors.ts";

export interface StockRecord {
  sku: string;
  onHand: number;
  reserved: number;
}

export interface Reservation {
  id: string;
  sku: string;
  quantity: number;
  createdAt: number;
}

export class Inventory {
  private readonly stock = new Map<string, StockRecord>();
  private readonly reservations = new Map<string, Reservation>();
  private sequence = 0;

  receive(sku: string, quantity: number): void {
    const record = this.stock.get(sku) ?? { sku, onHand: 0, reserved: 0 };
    record.onHand += quantity;
    this.stock.set(sku, record);
  }

  available(sku: string): number {
    const record = this.stock.get(sku);
    if (!record) return 0;
    return record.onHand - record.reserved;
  }

  reserve(sku: string, quantity: number, now = Date.now()): Reservation {
    const avail = this.available(sku);
    if (quantity > avail) {
      throw new OutOfStock(sku, avail, quantity);
    }
    const record = this.stock.get(sku)!;
    record.reserved += quantity;
    this.sequence += 1;
    const reservation: Reservation = {
      id: `res_${this.sequence}`,
      sku,
      quantity,
      createdAt: now,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    const record = this.stock.get(reservation.sku);
    if (record) {
      record.reserved -= reservation.quantity;
    }
    this.reservations.delete(reservationId);
  }

  commit(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    const record = this.stock.get(reservation.sku);
    if (record) {
      record.onHand -= reservation.quantity;
      record.reserved -= reservation.quantity;
    }
    this.reservations.delete(reservationId);
  }

  snapshot(): StockRecord[] {
    return [...this.stock.values()].map((r) => ({ ...r }));
  }
}
