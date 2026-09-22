/**
 * Category D: coding-agent-generated test changes.
 *
 * METHODOLOGY NOTE — read this before trusting any metric derived from these
 * cases.
 *
 * These diffs were produced by an agent (the author of this POC) working from
 * the task description in `task` against the `base` tree, in the mode a coding
 * agent operates in: get the task done, get the suite green, add tests that look
 * like they cover the work. The agent wrote each change before the expectation
 * was recorded.
 *
 * What that does NOT establish: that an *independent* agent, on an *unseen*
 * repository, produces these patterns at this rate. The author knows what
 * TestSlop detects, and that knowledge cannot be fully unlearned while writing
 * the samples. This is the single largest methodological weakness in POC-00 and
 * it is stated in the final report rather than buried here.
 *
 * What it does establish: the patterns are expressible in natural, plausible
 * agent output, and TestSlop's behaviour on such output is measurable and
 * reproducible.
 *
 * Mitigations applied:
 *   - d01 and d06 are cases where the agent did competent work. If TestSlop
 *     reports findings on them, that counts against TestSlop, and those results
 *     are reported.
 *   - Expected rule sets were written by reading the finished diff as a
 *     reviewer, not by consulting the rule registry.
 */

import type { CorpusCase } from "../types.ts";
import { tsScaffold } from "../types.ts";

// ---------------------------------------------------------------------------
// d01 — agent does competent work. Control case.

const d01: CorpusCase = {
  id: "d01-agent-pagination-fix",
  category: "D",
  intent: "The agent fixed the off-by-one correctly and wrote tests that pin the boundaries. Clean.",
  task: "Bug: /items?page=2&size=10 returns items 11-21 instead of 11-20. Fix it and add tests.",
  scaffold: tsScaffold("d01"),
  base: {
    "src/paginate.ts": `export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(all: T[], page: number, size: number): Page<T> {
  const start = (page - 1) * size;
  const end = start + size + 1;
  return {
    items: all.slice(start, end),
    page,
    size,
    total: all.length,
    totalPages: Math.ceil(all.length / size),
  };
}
`,
    "src/paginate.test.ts": `import { describe, expect, it } from "vitest";
import { paginate } from "./paginate.ts";

const items = Array.from({ length: 25 }, (_, i) => i + 1);

describe("paginate", () => {
  it("reports the total number of pages", () => {
    expect(paginate(items, 1, 10).totalPages).toBe(3);
  });
});
`,
  },
  change: {
    "src/paginate.ts": `export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(all: T[], page: number, size: number): Page<T> {
  const start = (page - 1) * size;
  const end = start + size;
  return {
    items: all.slice(start, end),
    page,
    size,
    total: all.length,
    totalPages: Math.ceil(all.length / size),
  };
}
`,
    "src/paginate.test.ts": `import { describe, expect, it } from "vitest";
import { paginate } from "./paginate.ts";

const items = Array.from({ length: 25 }, (_, i) => i + 1);

describe("paginate", () => {
  it("reports the total number of pages", () => {
    expect(paginate(items, 1, 10).totalPages).toBe(3);
  });

  it("returns exactly \`size\` items on a full page", () => {
    const result = paginate(items, 2, 10);
    expect(result.items).toHaveLength(10);
    expect(result.items).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("returns the first page starting at the first item", () => {
    expect(paginate(items, 1, 10).items[0]).toBe(1);
  });

  it("returns the remainder on the last page", () => {
    const result = paginate(items, 3, 10);
    expect(result.items).toEqual([21, 22, 23, 24, 25]);
  });

  it("returns nothing past the end", () => {
    expect(paginate(items, 9, 10).items).toEqual([]);
  });
});
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

// ---------------------------------------------------------------------------
// d02 — agent adds validation, tests only that it rejects, never what it rejects.

const d02: CorpusCase = {
  id: "d02-agent-input-validation",
  category: "D",
  intent:
    "The agent added five validation rules and one test that only checks that something throws. Four of the five rules are unverified.",
  task: "Add input validation to the signup handler: email format, password length, username charset.",
  scaffold: tsScaffold("d02"),
  base: {
    "src/signup.ts": `export interface SignupInput {
  email: string;
  password: string;
  username: string;
}

export interface Account {
  email: string;
  username: string;
}

export function signup(input: SignupInput): Account {
  return { email: input.email.toLowerCase(), username: input.username };
}
`,
    "src/signup.test.ts": `import { describe, expect, it } from "vitest";
import { signup } from "./signup.ts";

describe("signup", () => {
  it("lowercases the email", () => {
    const account = signup({ email: "Ada@Example.com", password: "hunter2hunter2", username: "ada" });
    expect(account.email).toBe("ada@example.com");
  });
});
`,
  },
  change: {
    "src/signup.ts": `export interface SignupInput {
  email: string;
  password: string;
  username: string;
}

export interface Account {
  email: string;
  username: string;
}

export class SignupError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SignupError";
  }
}

const EMAIL = /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/;
const USERNAME = /^[a-z0-9_]{3,20}$/;

export function signup(input: SignupInput): Account {
  if (!EMAIL.test(input.email)) {
    throw new SignupError("email", "email is not a valid address");
  }
  if (input.password.length < 12) {
    throw new SignupError("password", "password must be at least 12 characters");
  }
  if (input.password.toLowerCase().includes(input.username.toLowerCase())) {
    throw new SignupError("password", "password must not contain the username");
  }
  if (!USERNAME.test(input.username)) {
    throw new SignupError("username", "username must be 3-20 lowercase letters, digits or underscores");
  }
  return { email: input.email.toLowerCase(), username: input.username };
}
`,
    "src/signup.test.ts": `import { describe, expect, it } from "vitest";
import { signup } from "./signup.ts";

describe("signup", () => {
  it("lowercases the email", () => {
    const account = signup({ email: "Ada@Example.com", password: "hunter2hunter2", username: "ada" });
    expect(account.email).toBe("ada@example.com");
  });

  it("validates the input", () => {
    expect(() => signup({ email: "nope", password: "hunter2hunter2", username: "ada" })).toThrow();
  });

  it("returns an account for valid input", () => {
    const account = signup({ email: "ada@example.com", password: "correcthorsebattery", username: "ada" });
    expect(account).toBeDefined();
  });
});
`,
  },
  expect: {
    rules: ["weak-new-test"],
    tolerated: ["mock-only-test"],
  },
  mutation: {
    expectSurvivor: true,
    note:
      "Four of the five validation branches have no discriminating test. Mutating the password length boundary (12) should survive. " +
      "Note: `expect(account).toBeDefined()` in this diff is deliberately NOT reported, because a bare existence check on a whole result " +
      "is an honest smoke test. Mutation is what turns this case into evidence.",
  },
};

// ---------------------------------------------------------------------------
// d03 — the Self-Repair Trap, verbatim. Agent told only "make the test pass".

const d03: CorpusCase = {
  id: "d03-agent-make-the-test-pass",
  category: "D",
  intent:
    "Told to make a failing test pass, the agent changed the test's expectation and matcher rather than investigating the cache eviction bug.",
  task: "The cache test is failing on CI. Make the suite green.",
  scaffold: tsScaffold("d03"),
  base: {
    "src/cache.ts": `export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as K;
      this.entries.delete(oldest);
    }
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }
}
`,
    "src/cache.test.ts": `import { describe, expect, it } from "vitest";
import { LruCache } from "./cache.ts";

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.get("b")).toBeUndefined();
  });

  it("keeps at most \`capacity\` entries", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
  });
});
`,
  },
  change: {
    // The agent "fixed" the failure by rewriting the expectation to whatever the
    // implementation produced, and softened the second assertion. Production
    // code untouched — the eviction order bug is still there.
    "src/cache.test.ts": `import { describe, expect, it } from "vitest";
import { LruCache } from "./cache.ts";

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.keys()).toHaveLength(2);
    expect(cache.get("b")).toBeFalsy();
  });

  it("keeps at most \`capacity\` entries", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});
`,
  },
  expect: {
    rules: ["assertion-weakened"],
  },
};

// ---------------------------------------------------------------------------
// d04 — agent implements retry, tests assert call counts on fake timers only.

const d04: CorpusCase = {
  id: "d04-agent-retry-backoff",
  category: "D",
  intent:
    "The agent's tests verify that the operation was retried the right number of times, but never that the caller receives the right result or that the backoff delays are correct.",
  task: "Add exponential backoff retry to the HTTP client. Add tests.",
  scaffold: tsScaffold("d04"),
  base: {
    "src/client.ts": `export interface Response {
  status: number;
  body: string;
}

export type Transport = (url: string) => Promise<Response>;

export async function get(transport: Transport, url: string): Promise<Response> {
  return transport(url);
}
`,
    "src/client.test.ts": `import { describe, expect, it, vi } from "vitest";
import { get } from "./client.ts";

describe("get", () => {
  it("returns the transport response", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200, body: "ok" });
    const response = await get(transport, "/a");
    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");
  });
});
`,
  },
  change: {
    "src/client.ts": `export interface Response {
  status: number;
  body: string;
}

export type Transport = (url: string) => Promise<Response>;

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

const DEFAULTS: RetryConfig = { maxAttempts: 3, baseDelayMs: 100 };

function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

export function delayFor(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** (attempt - 1);
}

export async function get(
  transport: Transport,
  url: string,
  config: RetryConfig = DEFAULTS,
): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    last = await transport(url);
    if (!isRetryable(last.status)) return last;
    if (attempt < config.maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayFor(attempt, config.baseDelayMs)));
    }
  }
  return last!;
}
`,
    "src/client.test.ts": `import { describe, expect, it, vi } from "vitest";
import { get } from "./client.ts";

describe("get", () => {
  it("returns the transport response", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200, body: "ok" });
    const response = await get(transport, "/a");
    expect(response.status).toBe(200);
    expect(response.body).toBe("ok");
  });

  it("retries on a 500", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 500, body: "boom" });
    await get(transport, "/a", { maxAttempts: 3, baseDelayMs: 1 });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("does not retry on a 200", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 200, body: "ok" });
    await get(transport, "/a", { maxAttempts: 3, baseDelayMs: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retries on a 429", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 429, body: "slow down" });
    await get(transport, "/a", { maxAttempts: 2, baseDelayMs: 1 });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
`,
  },
  expect: {
    rules: ["mock-only-test"],
  },
  mutation: {
    expectSurvivor: true,
    note:
      "delayFor implements the exponential curve and nothing asserts on it. Mutating the exponent base or the retryable status boundary should survive.",
  },
};

// ---------------------------------------------------------------------------
// d05 — agent fixes a boundary bug and rewrites expectations from the new output.

const d05: CorpusCase = {
  id: "d05-agent-date-range-fix",
  category: "D",
  intent:
    "The agent changed the range to be inclusive and updated every expected count to whatever the new code produced, including one that was already correct.",
  task: "Bug: dateRange(start, end) excludes the end date. It should be inclusive.",
  scaffold: tsScaffold("d05"),
  base: {
    "src/daterange.ts": `const DAY_MS = 86_400_000;

export function dayCount(startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / DAY_MS);
}

export function dateRange(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  for (let t = startMs; t < endMs; t += DAY_MS) out.push(t);
  return out;
}
`,
    "src/daterange.test.ts": `import { describe, expect, it } from "vitest";
import { dateRange, dayCount } from "./daterange.ts";

const DAY = 86_400_000;
const JAN1 = Date.UTC(2024, 0, 1);

describe("dayCount", () => {
  it("counts whole days between two instants", () => {
    expect(dayCount(JAN1, JAN1 + 5 * DAY)).toBe(5);
  });
});

describe("dateRange", () => {
  it("lists the days in the range", () => {
    expect(dateRange(JAN1, JAN1 + 3 * DAY)).toHaveLength(3);
  });

  it("returns an empty range for identical bounds", () => {
    expect(dateRange(JAN1, JAN1)).toEqual([]);
  });
});
`,
  },
  change: {
    "src/daterange.ts": `const DAY_MS = 86_400_000;

export function dayCount(startMs: number, endMs: number): number {
  return Math.floor((endMs - startMs) / DAY_MS) + 1;
}

export function dateRange(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  for (let t = startMs; t <= endMs; t += DAY_MS) out.push(t);
  return out;
}
`,
    "src/daterange.test.ts": `import { describe, expect, it } from "vitest";
import { dateRange, dayCount } from "./daterange.ts";

const DAY = 86_400_000;
const JAN1 = Date.UTC(2024, 0, 1);

describe("dayCount", () => {
  it("counts whole days between two instants", () => {
    expect(dayCount(JAN1, JAN1 + 5 * DAY)).toBe(6);
  });
});

describe("dateRange", () => {
  it("lists the days in the range", () => {
    expect(dateRange(JAN1, JAN1 + 3 * DAY)).toHaveLength(4);
  });

  it("returns an empty range for identical bounds", () => {
    expect(dateRange(JAN1, JAN1)).toHaveLength(1);
  });
});
`,
  },
  expect: {
    // The third test is the interesting one: "returns an empty range for
    // identical bounds" now asserts the opposite of its own name.
    rules: ["expected-chasing-implementation"],
    tolerated: ["assertion-weakened", "assertion-removed"],
  },
};

// ---------------------------------------------------------------------------
// d06 — agent refactors without touching behaviour. Control case.

const d06: CorpusCase = {
  id: "d06-agent-refactor-no-test-change",
  category: "D",
  intent: "The agent refactored the tokeniser into smaller functions and left the tests alone. Clean.",
  task: "Refactor the tokeniser: it is one 40-line function. Keep all tests passing.",
  scaffold: tsScaffold("d06"),
  base: {
    "src/tokenise.ts": `export type Token =
  | { kind: "number"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string };

export function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === " " || ch === "\\t") {
      i += 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < input.length && input[j]! >= "0" && input[j]! <= "9") j += 1;
      tokens.push({ kind: "number", value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: "ident", value: input.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ kind: "op", value: ch });
    i += 1;
  }
  return tokens;
}
`,
    "src/tokenise.test.ts": `import { describe, expect, it } from "vitest";
import { tokenise } from "./tokenise.ts";

describe("tokenise", () => {
  it("reads a number", () => {
    expect(tokenise("42")).toEqual([{ kind: "number", value: 42 }]);
  });

  it("reads an identifier", () => {
    expect(tokenise("total_x")).toEqual([{ kind: "ident", value: "total_x" }]);
  });

  it("skips whitespace", () => {
    expect(tokenise("  1  ")).toEqual([{ kind: "number", value: 1 }]);
  });

  it("reads a mixed expression", () => {
    expect(tokenise("a + 12")).toEqual([
      { kind: "ident", value: "a" },
      { kind: "op", value: "+" },
      { kind: "number", value: 12 },
    ]);
  });
});
`,
  },
  change: {
    "src/tokenise.ts": `export type Token =
  | { kind: "number"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string };

const isSpace = (ch: string): boolean => ch === " " || ch === "\\t";
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isIdentStart = (ch: string): boolean => /[a-zA-Z_]/.test(ch);
const isIdentPart = (ch: string): boolean => /[a-zA-Z0-9_]/.test(ch);

function readWhile(input: string, from: number, predicate: (ch: string) => boolean): number {
  let j = from;
  while (j < input.length && predicate(input[j]!)) j += 1;
  return j;
}

export function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (isSpace(ch)) {
      i += 1;
    } else if (isDigit(ch)) {
      const j = readWhile(input, i, isDigit);
      tokens.push({ kind: "number", value: Number(input.slice(i, j)) });
      i = j;
    } else if (isIdentStart(ch)) {
      const j = readWhile(input, i, isIdentPart);
      tokens.push({ kind: "ident", value: input.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: "op", value: ch });
      i += 1;
    }
  }
  return tokens;
}
`,
  },
  expect: { rules: [], forbidden: ["*"] },
};

export const CATEGORY_D: CorpusCase[] = [d01, d02, d03, d04, d05, d06];
