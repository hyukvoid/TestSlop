/**
 * Category B: clean changes that superficially resemble Category A patterns.
 *
 * This is the more important half of the corpus. A tool that flags every
 * Category A case and also flags these is worthless, because the developer
 * cannot tell the two apart from the output — which means they will stop reading
 * the output.
 *
 * Each case names the specific Category A pattern it is designed to be confused
 * with.
 */

import type { CorpusCase } from "../types.ts";
import { tsScaffold } from "../types.ts";

// Confusable with: a01 (assertion-weakened)
// Assertions move in the *strengthening* direction.
const b01: CorpusCase = {
  id: "b01-assertion-strengthened",
  category: "B",
  intent: "Assertions became more specific. Nothing to report.",
  task: "Tighten up the loose assertions in the auth tests.",
  scaffold: tsScaffold("b01"),
  base: {
    "src/auth.ts": `export interface AuthResult {
  status: number;
  body: { error?: string; userId?: string };
}

export function authenticate(token: string | undefined): AuthResult {
  if (!token) return { status: 401, body: { error: "missing_token" } };
  if (token !== "good") return { status: 401, body: { error: "unknown_token" } };
  return { status: 200, body: { userId: "u1" } };
}
`,
    "src/auth.test.ts": `import { describe, expect, it } from "vitest";
import { authenticate } from "./auth.ts";

describe("authenticate", () => {
  it("rejects a request with no token", () => {
    const response = authenticate(undefined);
    expect(response.status).toBeDefined();
  });

  it("accepts a valid token", () => {
    const response = authenticate("good");
    expect(response.body.userId).toBeTruthy();
  });
});
`,
  },
  change: {
    "src/auth.test.ts": `import { describe, expect, it } from "vitest";
import { authenticate } from "./auth.ts";

describe("authenticate", () => {
  it("rejects a request with no token", () => {
    const response = authenticate(undefined);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("missing_token");
  });

  it("accepts a valid token", () => {
    const response = authenticate("good");
    expect(response.body.userId).toBe("u1");
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a04 (mock-only-test)
// Interaction assertions are present, but so are outcome assertions.
const b02: CorpusCase = {
  id: "b02-mocks-plus-outcome",
  category: "B",
  intent: "The new test checks collaborator calls AND the returned value. Correctly tested.",
  task: "Add a refund path to the payment service and test it.",
  scaffold: tsScaffold("b02"),
  base: {
    "src/gateway.ts": `export class Gateway {
  async refund(chargeId: string, amount: number): Promise<{ id: string; refunded: number }> {
    return { id: chargeId, refunded: amount };
  }
}
`,
    "src/payment.ts": `import { Gateway } from "./gateway.ts";

export interface Ledger {
  record(entry: { kind: string; amount: number }): void;
}

export class PaymentService {
  constructor(
    private readonly gateway: Gateway,
    private readonly ledger: Ledger,
  ) {}
}
`,
    "src/payment.test.ts": `import { describe, expect, it, vi } from "vitest";
import { PaymentService } from "./payment.ts";
import { Gateway } from "./gateway.ts";

describe("PaymentService", () => {
  it("can be constructed", () => {
    const service = new PaymentService(new Gateway(), { record: vi.fn() });
    expect(service).toBeInstanceOf(PaymentService);
  });
});
`,
  },
  change: {
    "src/payment.ts": `import { Gateway } from "./gateway.ts";

export interface Ledger {
  record(entry: { kind: string; amount: number }): void;
}

export class PaymentService {
  constructor(
    private readonly gateway: Gateway,
    private readonly ledger: Ledger,
  ) {}

  async refund(chargeId: string, amount: number): Promise<{ refunded: number }> {
    if (amount <= 0) throw new Error("refund must be positive");
    const result = await this.gateway.refund(chargeId, amount);
    this.ledger.record({ kind: "refund", amount: result.refunded });
    return { refunded: result.refunded };
  }
}
`,
    "src/payment.test.ts": `import { describe, expect, it, vi } from "vitest";
import { PaymentService } from "./payment.ts";
import { Gateway } from "./gateway.ts";

describe("PaymentService", () => {
  it("can be constructed", () => {
    const service = new PaymentService(new Gateway(), { record: vi.fn() });
    expect(service).toBeInstanceOf(PaymentService);
  });
});

describe("PaymentService.refund", () => {
  it("refunds through the gateway and reports the amount", async () => {
    const gateway = new Gateway();
    const refundSpy = vi.spyOn(gateway, "refund").mockResolvedValue({ id: "ch_1", refunded: 500 });
    const ledger = { record: vi.fn() };
    const service = new PaymentService(gateway, ledger);

    const result = await service.refund("ch_1", 500);

    expect(result.refunded).toBe(500);
    expect(refundSpy).toHaveBeenCalledWith("ch_1", 500);
    expect(ledger.record).toHaveBeenCalledWith({ kind: "refund", amount: 500 });
  });

  it("refuses a non-positive refund", async () => {
    const service = new PaymentService(new Gateway(), { record: vi.fn() });
    await expect(service.refund("ch_1", 0)).rejects.toThrow("refund must be positive");
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a02 (expected-chasing-implementation)
// Expected values change, but the production constant does NOT.
const b03: CorpusCase = {
  id: "b03-expectation-fixed-without-impl-change",
  category: "B",
  intent:
    "A test expectation was corrected to match the documented spec; the implementation was already right and did not change.",
  task: "The rounding test had the wrong expected value. Fix the test.",
  scaffold: tsScaffold("b03"),
  base: {
    "src/rounding.ts": `export function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function applyRate(amount: number, rate: number): number {
  return roundToCents(amount * rate);
}
`,
    "src/rounding.test.ts": `import { describe, expect, it } from "vitest";
import { applyRate, roundToCents } from "./rounding.ts";

describe("roundToCents", () => {
  it("rounds half up", () => {
    expect(roundToCents(1.005)).toBe(1);
  });
});

describe("applyRate", () => {
  it("applies the rate and rounds", () => {
    expect(applyRate(100, 0.075)).toBe(7.5);
  });
});
`,
  },
  change: {
    // Only the test changes: the 1.005 expectation was wrong (float repr), and
    // a second case is added. Production untouched.
    "src/rounding.test.ts": `import { describe, expect, it } from "vitest";
import { applyRate, roundToCents } from "./rounding.ts";

describe("roundToCents", () => {
  it("rounds half up", () => {
    expect(roundToCents(1.015)).toBe(1.02);
  });

  it("leaves an exact value alone", () => {
    expect(roundToCents(2.5)).toBe(2.5);
  });
});

describe("applyRate", () => {
  it("applies the rate and rounds", () => {
    expect(applyRate(100, 0.075)).toBe(7.5);
  });
});
`,
  },
  expect: { rules: [], forbidden: ["expected-chasing-implementation"] },
};

// Confusable with: a03 (test-disabled)
// A test that was already skipped stays skipped. No transition.
const b04: CorpusCase = {
  id: "b04-preexisting-skip-untouched",
  category: "B",
  intent: "An already-skipped test remains skipped. There is no new degradation in this diff.",
  task: "Add a timeout option to the fetch helper.",
  scaffold: tsScaffold("b04"),
  base: {
    "src/fetcher.ts": `export interface FetchOptions {
  retries?: number;
}

export async function fetchJson(url: string, options: FetchOptions = {}): Promise<{ url: string; retries: number }> {
  return { url, retries: options.retries ?? 0 };
}
`,
    "src/fetcher.test.ts": `import { describe, expect, it } from "vitest";
import { fetchJson } from "./fetcher.ts";

describe("fetchJson", () => {
  it("defaults retries to zero", async () => {
    expect(await fetchJson("/a")).toEqual({ url: "/a", retries: 0 });
  });

  it.skip("uses the ambient proxy configuration", async () => {
    expect(await fetchJson("/b")).toBeDefined();
  });
});
`,
  },
  change: {
    "src/fetcher.ts": `export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
}

export async function fetchJson(
  url: string,
  options: FetchOptions = {},
): Promise<{ url: string; retries: number; timeoutMs: number }> {
  return { url, retries: options.retries ?? 0, timeoutMs: options.timeoutMs ?? 5000 };
}
`,
    "src/fetcher.test.ts": `import { describe, expect, it } from "vitest";
import { fetchJson } from "./fetcher.ts";

describe("fetchJson", () => {
  it("defaults retries to zero", async () => {
    expect(await fetchJson("/a")).toEqual({ url: "/a", retries: 0, timeoutMs: 5000 });
  });

  it.skip("uses the ambient proxy configuration", async () => {
    expect(await fetchJson("/b")).toBeDefined();
  });

  it("honours an explicit timeout", async () => {
    expect(await fetchJson("/c", { timeoutMs: 250 })).toEqual({ url: "/c", retries: 0, timeoutMs: 250 });
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a05 (self-derived-oracle)
// The test uses literal expected values from the spec, not the formula.
const b05: CorpusCase = {
  id: "b05-literal-expectations-for-new-formula",
  category: "B",
  intent: "New discount logic covered by hand-computed literal expectations, including the boundaries.",
  task: "Add tiered volume discounts and cover them with tests.",
  scaffold: tsScaffold("b05"),
  base: {
    "src/pricing.ts": `export interface Line {
  unitPrice: number;
  quantity: number;
}

export function lineTotal(line: Line): number {
  return line.unitPrice * line.quantity;
}
`,
    "src/pricing.test.ts": `import { describe, expect, it } from "vitest";
import { lineTotal } from "./pricing.ts";

describe("lineTotal", () => {
  it("multiplies unit price by quantity", () => {
    expect(lineTotal({ unitPrice: 250, quantity: 4 })).toBe(1000);
  });
});
`,
  },
  change: {
    "src/pricing.ts": `export interface Line {
  unitPrice: number;
  quantity: number;
}

export function lineTotal(line: Line): number {
  return line.unitPrice * line.quantity;
}

export function discountRate(quantity: number): number {
  if (quantity >= 100) return 0.2;
  if (quantity >= 50) return 0.1;
  return 0;
}

export function discountedTotal(line: Line): number {
  return line.unitPrice * line.quantity * (1 - discountRate(line.quantity));
}
`,
    "src/pricing.test.ts": `import { describe, expect, it } from "vitest";
import { discountRate, discountedTotal, lineTotal } from "./pricing.ts";

describe("lineTotal", () => {
  it("multiplies unit price by quantity", () => {
    expect(lineTotal({ unitPrice: 250, quantity: 4 })).toBe(1000);
  });
});

describe("discountRate", () => {
  it("gives no discount below fifty units", () => {
    expect(discountRate(49)).toBe(0);
  });

  it("gives ten percent at exactly fifty units", () => {
    expect(discountRate(50)).toBe(0.1);
  });

  it("gives twenty percent at exactly one hundred units", () => {
    expect(discountRate(100)).toBe(0.2);
  });
});

describe("discountedTotal", () => {
  it("charges full price for a small order", () => {
    expect(discountedTotal({ unitPrice: 200, quantity: 2 })).toBe(400);
  });

  it("applies ten percent off a sixty unit order", () => {
    expect(discountedTotal({ unitPrice: 200, quantity: 60 })).toBe(10800);
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a01 via the positional-pairing fallback.
// A local variable is renamed; assertion strength is unchanged.
const b06: CorpusCase = {
  id: "b06-variable-renamed-same-strength",
  category: "B",
  intent: "Pure rename inside the test. The oracle is identical.",
  task: "Rename `res` to `response` in the tests for readability.",
  scaffold: tsScaffold("b06"),
  base: {
    "src/greet.ts": `export function greet(name: string): { text: string; length: number } {
  const text = \`Hello, \${name}!\`;
  return { text, length: text.length };
}
`,
    "src/greet.test.ts": `import { describe, expect, it } from "vitest";
import { greet } from "./greet.ts";

describe("greet", () => {
  it("builds the greeting", () => {
    const res = greet("Ada");
    expect(res.text).toBe("Hello, Ada!");
    expect(res.length).toBe(11);
  });
});
`,
  },
  change: {
    "src/greet.test.ts": `import { describe, expect, it } from "vitest";
import { greet } from "./greet.ts";

describe("greet", () => {
  it("builds the greeting", () => {
    const response = greet("Ada");
    expect(response.text).toBe("Hello, Ada!");
    expect(response.length).toBe(11);
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a09 (exception-broadened)
// The error expectation becomes MORE specific.
const b07: CorpusCase = {
  id: "b07-exception-narrowed",
  category: "B",
  intent: "A bare toThrow was replaced with a specific error class and message.",
  task: "Make the validation tests assert on the specific error.",
  scaffold: tsScaffold("b07"),
  base: {
    "src/validate.ts": `export class ValidationError extends Error {
  constructor(public readonly field: string) {
    super(\`\${field} is invalid\`);
    this.name = "ValidationError";
  }
}

export function validateAge(age: number): number {
  if (!Number.isInteger(age)) throw new ValidationError("age");
  if (age < 0 || age > 150) throw new ValidationError("age");
  return age;
}
`,
    "src/validate.test.ts": `import { describe, expect, it } from "vitest";
import { validateAge } from "./validate.ts";

describe("validateAge", () => {
  it("accepts a plausible age", () => {
    expect(validateAge(37)).toBe(37);
  });

  it("rejects a negative age", () => {
    expect(() => validateAge(-1)).toThrow();
  });
});
`,
  },
  change: {
    "src/validate.test.ts": `import { describe, expect, it } from "vitest";
import { ValidationError, validateAge } from "./validate.ts";

describe("validateAge", () => {
  it("accepts a plausible age", () => {
    expect(validateAge(37)).toBe(37);
  });

  it("rejects a negative age", () => {
    expect(() => validateAge(-1)).toThrow(ValidationError);
  });

  it("rejects a non-integer age", () => {
    expect(() => validateAge(1.5)).toThrow("age is invalid");
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a07 (assertion-removed)
// Assertions move to a new dedicated test rather than disappearing.
const b08: CorpusCase = {
  id: "b08-assertions-split-into-new-test",
  category: "B",
  intent:
    "One broad test was split into two focused tests. The total number of assertions went up, not down.",
  task: "Split the normaliseUser test so failures point at the right field.",
  scaffold: tsScaffold("b08"),
  base: {
    "src/user.ts": `export function normaliseUser(input: { email: string; name: string }): {
  email: string;
  name: string;
  slug: string;
} {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  return { email, name, slug: name.toLowerCase().replace(/\\s+/g, "-") };
}
`,
    "src/user.test.ts": `import { describe, expect, it } from "vitest";
import { normaliseUser } from "./user.ts";

describe("normaliseUser", () => {
  it("normalises everything", () => {
    const result = normaliseUser({ email: "  Ada@Example.COM ", name: "  Ada Lovelace  " });
    expect(result.email).toBe("ada@example.com");
    expect(result.name).toBe("Ada Lovelace");
    expect(result.slug).toBe("ada-lovelace");
  });
});
`,
  },
  change: {
    "src/user.test.ts": `import { describe, expect, it } from "vitest";
import { normaliseUser } from "./user.ts";

describe("normaliseUser", () => {
  it("normalises everything", () => {
    const result = normaliseUser({ email: "  Ada@Example.COM ", name: "  Ada Lovelace  " });
    expect(result.email).toBe("ada@example.com");
  });

  it("trims the name", () => {
    const result = normaliseUser({ email: "a@b.c", name: "  Ada Lovelace  " });
    expect(result.name).toBe("Ada Lovelace");
  });

  it("builds a hyphenated slug", () => {
    const result = normaliseUser({ email: "a@b.c", name: "Ada Lovelace" });
    expect(result.slug).toBe("ada-lovelace");
  });
});
`,
  },
  expect: {
    rules: [],
    // Honest note: assertion-removed legitimately sees the first test shrink.
    // Whether that is noise is exactly what the corpus is measuring.
    tolerated: ["assertion-removed"],
  },
};

// Confusable with: a10 (test-only-production-path)
// An env check is added, but it is a legitimate production feature flag.
const b09: CorpusCase = {
  id: "b09-production-env-flag",
  category: "B",
  intent: "A production configuration flag that has nothing to do with tests.",
  task: "Allow the log level to be configured from the environment.",
  scaffold: tsScaffold("b09"),
  base: {
    "src/logger.ts": `export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Level[] = ["debug", "info", "warn", "error"];

export function shouldLog(level: Level, threshold: Level): boolean {
  return ORDER.indexOf(level) >= ORDER.indexOf(threshold);
}
`,
    "src/logger.test.ts": `import { describe, expect, it } from "vitest";
import { shouldLog } from "./logger.ts";

describe("shouldLog", () => {
  it("logs at or above the threshold", () => {
    expect(shouldLog("warn", "info")).toBe(true);
  });

  it("suppresses below the threshold", () => {
    expect(shouldLog("debug", "info")).toBe(false);
  });
});
`,
  },
  change: {
    "src/logger.ts": `export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Level[] = ["debug", "info", "warn", "error"];

export function shouldLog(level: Level, threshold: Level): boolean {
  return ORDER.indexOf(level) >= ORDER.indexOf(threshold);
}

export function configuredThreshold(env: Record<string, string | undefined> = process.env): Level {
  const raw = env.LOG_LEVEL?.toLowerCase();
  if (raw && (ORDER as string[]).includes(raw)) return raw as Level;
  return "info";
}
`,
    "src/logger.test.ts": `import { describe, expect, it } from "vitest";
import { configuredThreshold, shouldLog } from "./logger.ts";

describe("shouldLog", () => {
  it("logs at or above the threshold", () => {
    expect(shouldLog("warn", "info")).toBe(true);
  });

  it("suppresses below the threshold", () => {
    expect(shouldLog("debug", "info")).toBe(false);
  });
});

describe("configuredThreshold", () => {
  it("reads a valid level from the environment", () => {
    expect(configuredThreshold({ LOG_LEVEL: "warn" })).toBe("warn");
  });

  it("falls back to info for an unknown level", () => {
    expect(configuredThreshold({ LOG_LEVEL: "loud" })).toBe("info");
  });

  it("falls back to info when unset", () => {
    expect(configuredThreshold({})).toBe("info");
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a01/a06. A genuine refactor with no behavioural change.
const b10: CorpusCase = {
  id: "b10-pure-refactor",
  category: "B",
  intent: "Implementation restructured, behaviour and tests identical.",
  task: "Extract the zone lookup into its own function.",
  scaffold: tsScaffold("b10"),
  base: {
    "src/shipping.ts": `export interface Parcel {
  weightKg: number;
  zone: "domestic" | "eu" | "world";
}

export function estimate(parcel: Parcel): number {
  let base: number;
  if (parcel.zone === "domestic") base = 4.5;
  else if (parcel.zone === "eu") base = 9;
  else base = 19;
  const surcharge = parcel.weightKg > 10 ? (parcel.weightKg - 10) * 1.5 : 0;
  return Math.round((base + surcharge) * 100) / 100;
}
`,
    "src/shipping.test.ts": `import { describe, expect, it } from "vitest";
import { estimate } from "./shipping.ts";

describe("estimate", () => {
  it("charges the flat domestic rate below the threshold", () => {
    expect(estimate({ weightKg: 2, zone: "domestic" })).toBe(4.5);
  });

  it("adds a surcharge above ten kilos", () => {
    expect(estimate({ weightKg: 14, zone: "eu" })).toBe(15);
  });

  it("charges the world rate", () => {
    expect(estimate({ weightKg: 1, zone: "world" })).toBe(19);
  });
});
`,
  },
  change: {
    "src/shipping.ts": `export interface Parcel {
  weightKg: number;
  zone: "domestic" | "eu" | "world";
}

const RATES: Record<Parcel["zone"], number> = {
  domestic: 4.5,
  eu: 9,
  world: 19,
};

function baseRate(zone: Parcel["zone"]): number {
  return RATES[zone];
}

function weightSurcharge(weightKg: number): number {
  return weightKg > 10 ? (weightKg - 10) * 1.5 : 0;
}

export function estimate(parcel: Parcel): number {
  const total = baseRate(parcel.zone) + weightSurcharge(parcel.weightKg);
  return Math.round(total * 100) / 100;
}
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a02. Production constant AND test change, but the test change
// is a strengthening that adds a boundary case, and the numbers are independent.
const b11: CorpusCase = {
  id: "b11-legit-spec-change-with-new-boundaries",
  category: "B",
  intent:
    "A documented policy change: free shipping threshold moved. The tests were rewritten around the new policy including both sides of the boundary.",
  task: "Free shipping now starts at 50 EUR instead of 100 EUR (see POLICY.md).",
  scaffold: tsScaffold("b11"),
  base: {
    "POLICY.md": "Free shipping applies from 100 EUR.\n",
    "src/shippingpolicy.ts": `export function shippingCost(orderTotal: number): number {
  if (orderTotal >= 100) return 0;
  return 4.99;
}
`,
    "src/shippingpolicy.test.ts": `import { describe, expect, it } from "vitest";
import { shippingCost } from "./shippingpolicy.ts";

describe("shippingCost", () => {
  it("charges for a small order", () => {
    expect(shippingCost(20)).toBe(4.99);
  });

  it("is free at the threshold", () => {
    expect(shippingCost(100)).toBe(0);
  });
});
`,
  },
  change: {
    "POLICY.md": "Free shipping applies from 50 EUR.\n",
    "src/shippingpolicy.ts": `export function shippingCost(orderTotal: number): number {
  if (orderTotal >= 50) return 0;
  return 4.99;
}
`,
    "src/shippingpolicy.test.ts": `import { describe, expect, it } from "vitest";
import { shippingCost } from "./shippingpolicy.ts";

describe("shippingCost", () => {
  it("charges for a small order", () => {
    expect(shippingCost(20)).toBe(4.99);
  });

  it("still charges just below the threshold", () => {
    expect(shippingCost(49.99)).toBe(4.99);
  });

  it("is free at the threshold", () => {
    expect(shippingCost(50)).toBe(0);
  });

  it("is free above the threshold", () => {
    expect(shippingCost(120)).toBe(0);
  });
});
`,
  },
  expect: {
    rules: [],
    // The rule is *designed* to surface this coupling for review. Whether that
    // is acceptable or annoying is a finding of the POC, so it is tolerated
    // rather than counted as a clean pass or a false positive.
    tolerated: ["expected-chasing-implementation"],
  },
};

// Confusable with: a13 (pytest weakening). Python case that is clean.
const b12: CorpusCase = {
  id: "b12-pytest-clean-strengthening",
  category: "B",
  intent: "pytest assertions became more specific and a boundary case was added.",
  task: "Improve the Python discount tests.",
  base: {
    "app/discount.py": `def discount_rate(quantity):
    if quantity >= 100:
        return 0.2
    if quantity >= 50:
        return 0.1
    return 0.0
`,
    "tests/test_discount.py": `from app.discount import discount_rate


def test_small_order():
    assert discount_rate(1) is not None


def test_large_order():
    assert discount_rate(200)
`,
  },
  change: {
    "tests/test_discount.py": `import pytest

from app.discount import discount_rate


def test_small_order():
    assert discount_rate(1) == 0.0


def test_boundary_at_fifty():
    assert discount_rate(49) == 0.0
    assert discount_rate(50) == 0.1


def test_boundary_at_hundred():
    assert discount_rate(99) == 0.1
    assert discount_rate(100) == 0.2


def test_large_order():
    assert discount_rate(200) == pytest.approx(0.2)
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a08 (snapshot-replaced-assertion). A snapshot is ADDED
// alongside existing explicit assertions rather than replacing them.
const b13: CorpusCase = {
  id: "b13-snapshot-added-alongside-assertions",
  category: "B",
  intent: "A snapshot supplements the explicit expectations instead of replacing them.",
  task: "Add a snapshot of the rendered invoice as a regression guard.",
  scaffold: tsScaffold("b13"),
  base: {
    "src/invoice.ts": `export function renderInvoice(input: { number: string; amount: number }): {
  header: string;
  total: number;
} {
  return { header: \`Invoice \${input.number}\`, total: input.amount };
}
`,
    "src/invoice.test.ts": `import { describe, expect, it } from "vitest";
import { renderInvoice } from "./invoice.ts";

describe("renderInvoice", () => {
  it("renders the header and total", () => {
    const result = renderInvoice({ number: "2024-001", amount: 1250.5 });
    expect(result.header).toBe("Invoice 2024-001");
    expect(result.total).toBe(1250.5);
  });
});
`,
  },
  change: {
    "src/invoice.test.ts": `import { describe, expect, it } from "vitest";
import { renderInvoice } from "./invoice.ts";

describe("renderInvoice", () => {
  it("renders the header and total", () => {
    const result = renderInvoice({ number: "2024-001", amount: 1250.5 });
    expect(result.header).toBe("Invoice 2024-001");
    expect(result.total).toBe(1250.5);
    expect(result).toMatchSnapshot();
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// Confusable with: a12 (mock-scope-expanded). A dependency is mocked, not the
// subject under test.
const b14: CorpusCase = {
  id: "b14-dependency-mocked-not-subject",
  category: "B",
  intent: "A slow external dependency is mocked; the module under test runs for real.",
  task: "Test the report builder without hitting the clock.",
  scaffold: tsScaffold("b14"),
  base: {
    "src/clock.ts": `export function now(): number {
  return Date.now();
}
`,
    "src/report.ts": `import { now } from "./clock.ts";

export function buildReport(rows: number[]): { generatedAt: number; count: number; sum: number } {
  return {
    generatedAt: now(),
    count: rows.length,
    sum: rows.reduce((a, b) => a + b, 0),
  };
}
`,
    "src/report.test.ts": `import { describe, expect, it } from "vitest";
import { buildReport } from "./report.ts";

describe("buildReport", () => {
  it("counts and sums the rows", () => {
    const result = buildReport([1, 2, 3]);
    expect(result.count).toBe(3);
    expect(result.sum).toBe(6);
  });
});
`,
  },
  change: {
    "src/report.test.ts": `import { describe, expect, it, vi } from "vitest";
import { buildReport } from "./report.ts";

vi.mock("./clock.ts", () => ({ now: () => 1_700_000_000_000 }));

describe("buildReport", () => {
  it("counts and sums the rows", () => {
    const result = buildReport([1, 2, 3]);
    expect(result.count).toBe(3);
    expect(result.sum).toBe(6);
  });

  it("stamps the generation time from the clock", () => {
    const result = buildReport([]);
    expect(result.generatedAt).toBe(1_700_000_000_000);
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

export const CATEGORY_B: CorpusCase[] = [
  b01, b02, b03, b04, b05, b06, b07, b08, b09, b10, b11, b12, b13, b14,
];
