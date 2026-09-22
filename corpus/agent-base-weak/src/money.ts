/**
 * Money is represented as integer cents throughout the service. Floating point
 * currency arithmetic is the source of too many rounding complaints.
 */

export interface Money {
  cents: number;
  currency: string;
}

export function money(cents: number, currency = "EUR"): Money {
  if (!Number.isInteger(cents)) {
    throw new TypeError(`money requires integer cents, got ${cents}`);
  }
  return { cents, currency };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { cents: a.cents + b.cents, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { cents: a.cents - b.cents, currency: a.currency };
}

export function multiply(a: Money, factor: number): Money {
  return { cents: Math.round(a.cents * factor), currency: a.currency };
}

export function compare(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.cents - b.cents;
}

export function isZero(a: Money): boolean {
  return a.cents === 0;
}

export function format(a: Money): string {
  const sign = a.cents < 0 ? "-" : "";
  const abs = Math.abs(a.cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac} ${a.currency}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
