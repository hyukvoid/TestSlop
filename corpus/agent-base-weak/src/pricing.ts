import { type Money, add, money, multiply } from "./money.ts";

export interface OrderLine {
  sku: string;
  unitPriceCents: number;
  quantity: number;
}

export interface PricedOrder {
  lines: Array<{ sku: string; subtotal: Money; discount: Money; total: Money }>;
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
}

export const STANDARD_TAX_RATE = 0.19;
export const REDUCED_TAX_RATE = 0.07;

const REDUCED_RATE_SKUS = new Set(["BOOK", "FOOD", "MEDS"]);

export function taxRateFor(sku: string): number {
  const prefix = sku.split("-")[0] ?? "";
  return REDUCED_RATE_SKUS.has(prefix) ? REDUCED_TAX_RATE : STANDARD_TAX_RATE;
}

/**
 * Volume discount tiers. Applied per line, based on that line's quantity.
 */
export function volumeDiscountRate(quantity: number): number {
  if (quantity >= 100) return 0.15;
  if (quantity >= 50) return 0.1;
  if (quantity >= 20) return 0.05;
  return 0;
}

export function lineSubtotal(line: OrderLine): Money {
  return money(line.unitPriceCents * line.quantity);
}

export function priceOrder(lines: OrderLine[]): PricedOrder {
  let subtotal = money(0);
  let discount = money(0);
  let tax = money(0);

  const priced = lines.map((line) => {
    const lineSub = lineSubtotal(line);
    const lineDiscount = multiply(lineSub, volumeDiscountRate(line.quantity));
    const lineNet = money(lineSub.cents - lineDiscount.cents);
    const lineTax = multiply(lineNet, taxRateFor(line.sku));

    subtotal = add(subtotal, lineSub);
    discount = add(discount, lineDiscount);
    tax = add(tax, lineTax);

    return { sku: line.sku, subtotal: lineSub, discount: lineDiscount, total: lineNet };
  });

  const net = money(subtotal.cents - discount.cents);
  return { lines: priced, subtotal, discount, tax, total: add(net, tax) };
}
