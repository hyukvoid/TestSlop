/**
 * Rule behaviour tests, driven from synthetic before/after pairs.
 *
 * Two groups:
 *   - positive cases: the pattern each rule exists to catch
 *   - regression cases: every false positive the real-world corpus exposed, kept
 *     as a test so a future change cannot quietly reintroduce it
 *
 * The regression group is the more valuable half. Each one names the repository
 * and commit shape it came from.
 */

import { describe, expect, it } from "vitest";
import { classifyPath, syntheticChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import type { Finding } from "../src/core/types.ts";

interface FileSpec {
  path: string;
  before?: string;
  after?: string;
}

async function scan(files: FileSpec[]): Promise<Finding[]> {
  const cs = syntheticChangeSet(files);
  const result = await analyse(cs, { python: false });
  return result.findings;
}

const ruleIds = (findings: Finding[]): string[] => [...new Set(findings.map((f) => f.ruleId))];

const wrap = (body: string, name = "does the thing"): string =>
  `import { describe, expect, it, vi } from "vitest";
import { thing } from "./subject.ts";

describe("subject", () => {
  it("${name}", () => {
${body}
  });
});
`;

// ---------------------------------------------------------------------------
// assertion-weakened
// ---------------------------------------------------------------------------

describe("assertion-weakened", () => {
  it("reports an exact assertion collapsing to an existence check", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    const response = thing();\n    expect(response.status).toBe(401);`),
        after: wrap(`    const response = thing();\n    expect(response.status).toBeDefined();`),
      },
    ]);
    const f = findings.find((x) => x.ruleId === "assertion-weakened");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.message).toContain("EXACT");
    expect(f!.message).toContain("EXISTENCE");
    expect(f!.evidence[0]!.before).toContain("toBe(401)");
    expect(f!.evidence[0]!.after).toContain("toBeDefined()");
  });

  it("stays silent when the assertion gets stronger", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    const response = thing();\n    expect(response.status).toBeDefined();`),
        after: wrap(`    const response = thing();\n    expect(response.status).toBe(401);`),
      },
    ]);
    expect(ruleIds(findings)).not.toContain("assertion-weakened");
  });

  it("pairs assertions by subject, not by position", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(
          `    const r = thing();\n    expect(r.a).toBe(1);\n    expect(r.b).toBe(2);`,
        ),
        after: wrap(
          `    const r = thing();\n    expect(r.b).toBe(2);\n    expect(r.a).toBeTruthy();`,
        ),
      },
    ]);
    const weakened = findings.filter((f) => f.ruleId === "assertion-weakened");
    expect(weakened).toHaveLength(1);
    expect(weakened[0]!.message).toContain("r.a");
  });

  it("reports toBe(true) becoming not.toBe(false)", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing(1, 2)).toBe(true);`),
        after: wrap(`    expect(thing(1, 2)).not.toBe(false);`),
      },
    ]);
    expect(ruleIds(findings)).toContain("assertion-weakened");
  });

  it("does not fire across differently named tests", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(1);`, "case one"),
        after: wrap(`    expect(thing()).toBeDefined();`, "case two"),
      },
    ]);
    expect(ruleIds(findings)).not.toContain("assertion-weakened");
  });
});

// ---------------------------------------------------------------------------
// assertion-removed
// ---------------------------------------------------------------------------

describe("assertion-removed", () => {
  it("reports a test that kept its name but lost every assertion", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    const r = thing();\n    expect(r.a).toBe(1);\n    expect(r.b).toBe(2);`),
        after: wrap(`    const r = thing();\n    console.log(r);`),
      },
    ]);
    const f = findings.find((x) => x.ruleId === "assertion-removed");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.message).toContain("no longer asserts anything");
  });

  it("REGRESSION (zustand 257ac06a): a test rewritten to use a throwing query has not lost its oracle", async () => {
    // Two `expect(count).toBe(n)` calls inside a render callback were replaced by
    // `await waitForElement(() => getByText('count: 0'))`, which is a better test.
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(
          `    let renderCount = 0;\n    renderCount++;\n    if (renderCount === 1) { expect(renderCount).toBe(1); } else { expect(renderCount).toBe(0); }`,
        ),
        after: wrap(
          `    const { getByText } = render(thing());\n    await waitForElement(() => getByText("count: 0"));`,
        ),
      },
    ]);
    expect(ruleIds(findings)).not.toContain("assertion-removed");
  });
});

// ---------------------------------------------------------------------------
// test-disabled / test-removed
// ---------------------------------------------------------------------------

describe("test-disabled", () => {
  it("reports an active test switched to skip", async () => {
    const before = `import { it, expect } from "vitest";
import { thing } from "./subject.ts";
it("checks the thing", () => { expect(thing()).toBe(3); });
`;
    const after = `import { it, expect } from "vitest";
import { thing } from "./subject.ts";
it.skip("checks the thing", () => { expect(thing()).toBe(3); });
`;
    const findings = await scan([{ path: "src/subject.test.ts", before, after }]);
    const f = findings.find((x) => x.ruleId === "test-disabled");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.confidence).toBeGreaterThan(0.9);
  });

  it("stays silent for a test that was already skipped", async () => {
    const src = `import { it, expect } from "vitest";
import { thing } from "./subject.ts";
it.skip("checks the thing", () => { expect(thing()).toBe(3); });
it("another", () => { expect(thing()).toBe(4); });
`;
    const findings = await scan([
      { path: "src/subject.test.ts", before: src, after: src + `it("third", () => { expect(thing()).toBe(5); });\n` },
    ]);
    expect(ruleIds(findings)).not.toContain("test-disabled");
  });
});

describe("test-removed", () => {
  const mk = (tests: string[]): string =>
    `import { it, expect } from "vitest";\nimport { thing } from "./subject.ts";\n` + tests.join("\n") + "\n";
  const t = (name: string, body: string): string => `it("${name}", () => { ${body} });`;

  it("reports a file that lost test cases and assertions", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: mk([t("a", "expect(thing()).toBe(1);"), t("b", "expect(thing(2)).toBe(2);")]),
        after: mk([t("a", "expect(thing()).toBe(1);")]),
      },
      { path: "src/subject.ts", before: "export const thing = () => 1;", after: "export const thing = () => 2;" },
    ]);
    const f = findings.find((x) => x.ruleId === "test-removed");
    expect(f).toBeDefined();
    expect(f!.message).toContain("1 test case removed");
  });

  it("REGRESSION (zustand c54d1df8): a renamed test is not a removed test", async () => {
    // `sends { type: setStateName ?? 'anonymous` }` became
    // `sends { type: setStateName || 'anonymous` }` — one character, same body.
    const body = "const r = thing(); expect(r.value).toBe(42);";
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: mk([t("sends the value using ?? for the default", body)]),
        after: mk([t("sends the value using || for the default", body)]),
      },
    ]);
    expect(ruleIds(findings)).not.toContain("test-removed");
  });

  it("REGRESSION (zustand e414f7cc): a test moved to another file is not a removed test", async () => {
    const body = "expect(thing(1, 1)).toBe(true);";
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: mk([t("compares primitives", body), t("stays", "expect(thing()).toBe(0);")]),
        after: mk([t("stays", "expect(thing()).toBe(0);")]),
      },
      {
        path: "src/extracted.test.ts",
        after: mk([t("compares primitives", body)]),
      },
    ]);
    expect(ruleIds(findings)).not.toContain("test-removed");
  });

  it("REGRESSION: reorganising describe blocks is not a removal", async () => {
    const inner = `it("checks it", () => { expect(thing()).toBe(1); });`;
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: `import { describe, it, expect } from "vitest";\nimport { thing } from "./subject.ts";\ndescribe("old group", () => { ${inner} });\n`,
        after: `import { describe, it, expect } from "vitest";\nimport { thing } from "./subject.ts";\ndescribe("new group", () => { describe("nested", () => { ${inner} }); });\n`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("test-removed");
  });
});

// ---------------------------------------------------------------------------
// mock-only-test
// ---------------------------------------------------------------------------

describe("mock-only-test", () => {
  it("reports a new test that only counts calls", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(1);`, "existing"),
        after:
          wrap(`    expect(thing()).toBe(1);`, "existing") +
          `
it("refunds", async () => {
  const spy = vi.fn();
  await thing(spy);
  expect(spy).toHaveBeenCalled();
  expect(spy).toHaveBeenCalledTimes(1);
});
`,
      },
    ]);
    expect(ruleIds(findings)).toContain("mock-only-test");
  });

  it("REGRESSION (zustand devtools): an interaction assertion pinning concrete arguments is an outcome assertion", async () => {
    // `expect(connection.send).toHaveBeenLastCalledWith({ type: 'setCount' },
    //  { count: 10, setCount: expect.any(Function) })` is the complete contract of
    // an emitter. The partial expect.any must not disqualify the literal parts.
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(1);`, "existing"),
        after:
          wrap(`    expect(thing()).toBe(1);`, "existing") +
          `
it("emits the action", () => {
  const connection = { send: vi.fn() };
  thing(connection);
  expect(connection.send).toHaveBeenLastCalledWith({ type: "setCount" }, { count: 10, setCount: expect.any(Function) });
});
`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("mock-only-test");
  });

  it("stays silent when an outcome assertion is present alongside the interaction", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(1);`, "existing"),
        after:
          wrap(`    expect(thing()).toBe(1);`, "existing") +
          `
it("refunds", async () => {
  const spy = vi.fn();
  const result = await thing(spy);
  expect(result.refunded).toBe(500);
  expect(spy).toHaveBeenCalled();
});
`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("mock-only-test");
  });
});

// ---------------------------------------------------------------------------
// weak-new-test
// ---------------------------------------------------------------------------

describe("weak-new-test", () => {
  it("reports a new test that only checks a field exists", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(1);`, "existing"),
        after:
          wrap(`    expect(thing()).toBe(1);`, "existing") +
          `
it("handles an expired token", () => {
  const response = thing("stale");
  expect(response.status).toBeDefined();
});
`,
      },
    ]);
    expect(ruleIds(findings)).toContain("weak-new-test");
  });

  it("REGRESSION (zustand middlewareTypes): an existence check on a whole result is an honest smoke test", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(1);`, "existing"),
        after:
          wrap(`    expect(thing()).toBe(1);`, "existing") +
          `
it("can be constructed", () => {
  const useBoundStore = thing({ count: 0 });
  expect(useBoundStore).toBeDefined();
});
`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("weak-new-test");
  });

  it("REGRESSION (zustand 5b3b9631): not.toThrow is a deliberate contract, not a weak value check", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(1);`, "existing"),
        after:
          wrap(`    expect(thing()).toBe(1);`, "existing") +
          `
it("works in a non-browser env", () => {
  expect(() => { thing({ count: 0 }); }).not.toThrow();
});
`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("weak-new-test");
  });

  it("skips type-test files", async () => {
    const findings = await scan([
      {
        path: "src/subjectTypes.test.ts",
        before: `import { it, expect } from "vitest";\nimport { thing } from "./subject.ts";\nit("a", () => { expect(thing()).toBe(1); });\n`,
        after: `import { it, expect } from "vitest";\nimport { thing } from "./subject.ts";\nit("a", () => { expect(thing()).toBe(1); });\nit("b", () => { const x = thing({}); expect(x.inner).toBeDefined(); });\n`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("weak-new-test");
  });
});

// ---------------------------------------------------------------------------
// expected-chasing-implementation
// ---------------------------------------------------------------------------

describe("expected-chasing-implementation", () => {
  const testBefore = `import { describe, expect, it } from "vitest";
import { calculateTax } from "./tax.ts";

describe("calculateTax", () => {
  it("applies the standard rate", () => {
    expect(calculateTax({ subtotal: 1000 })).toBe(120);
  });
});
`;
  const testAfter = testBefore.replace("toBe(120)", "toBe(100)");
  const prodBefore = `export function calculateTax(order: { subtotal: number }): number {
  return order.subtotal * 0.12;
}
`;
  const prodAfter = prodBefore.replace("0.12", "0.1");

  it("reports the coupling and proves the expectation is derivable from the new constant", async () => {
    const findings = await scan([
      { path: "src/tax.test.ts", before: testBefore, after: testAfter },
      { path: "src/tax.ts", before: prodBefore, after: prodAfter },
    ]);
    const f = findings.find((x) => x.ruleId === "expected-chasing-implementation");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.productionFile).toBe("src/tax.ts");
    const derivation = f!.evidence.find((e) => e.label === "Derivation");
    expect(derivation?.detail).toContain("same ratio");
  });

  it("stays silent when only the test changed", async () => {
    const findings = await scan([{ path: "src/tax.test.ts", before: testBefore, after: testAfter }]);
    expect(ruleIds(findings)).not.toContain("expected-chasing-implementation");
  });

  it("reports at lower confidence when the new expectation is not derivable", async () => {
    const findings = await scan([
      { path: "src/tax.test.ts", before: testBefore, after: testBefore.replace("toBe(120)", "toBe(777)") },
      { path: "src/tax.ts", before: prodBefore, after: prodAfter },
    ]);
    const f = findings.find((x) => x.ruleId === "expected-chasing-implementation");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("medium");
    expect(f!.evidence.some((e) => e.label === "Derivation")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// self-derived-oracle
// ---------------------------------------------------------------------------

describe("self-derived-oracle", () => {
  it("reports an assertion comparing an expression to itself", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: `import { it, expect } from "vitest";\nimport { thing } from "./subject.ts";\nit("a", () => { expect(thing(1)).toBe(2); });\n`,
        after: `import { it, expect } from "vitest";\nimport { thing } from "./subject.ts";\nit("a", () => { expect(thing(1)).toBe(2); });\nit("b", () => { expect(thing(3)).toBe(thing(3)); });\n`,
      },
    ]);
    const f = findings.find((x) => x.ruleId === "self-derived-oracle");
    expect(f).toBeDefined();
    expect(f!.confidence).toBeGreaterThan(0.9);
  });

  it("reports an expectation that re-implements the production formula", async () => {
    const prod = `export function discountRate(quantity: number): number {
  return quantity >= 50 ? 0.1 : 0;
}

export function discountedTotal(line: { unitPrice: number; quantity: number }): number {
  return line.unitPrice * line.quantity * (1 - discountRate(line.quantity));
}
`;
    const findings = await scan([
      { path: "src/pricing.ts", before: "export const x = 1;\n", after: prod },
      {
        path: "src/pricing.test.ts",
        before: `import { it, expect } from "vitest";\nimport { discountedTotal } from "./pricing.ts";\nit("a", () => { expect(1).toBe(1); });\n`,
        after: `import { it, expect } from "vitest";
import { discountRate, discountedTotal } from "./pricing.ts";
it("a", () => { expect(1).toBe(1); });
it("applies the discount", () => {
  const line = { unitPrice: 200, quantity: 60 };
  expect(discountedTotal(line)).toBe(line.unitPrice * line.quantity * (1 - discountRate(line.quantity)));
});
`,
      },
    ]);
    expect(ruleIds(findings)).toContain("self-derived-oracle");
  });

  it("stays silent for a literal expectation", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: `import { it, expect } from "vitest";\nimport { thing } from "./subject.ts";\nit("a", () => { expect(thing(1)).toBe(2); });\n`,
        after: `import { it, expect } from "vitest";\nimport { thing } from "./subject.ts";\nit("a", () => { expect(thing(1)).toBe(2); });\nit("b", () => { expect(thing(3)).toBe(10800); });\n`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("self-derived-oracle");
  });
});

// ---------------------------------------------------------------------------
// production-side rules
// ---------------------------------------------------------------------------

describe("test-only-production-path", () => {
  it("reports a new NODE_ENV=test branch in production code", async () => {
    const findings = await scan([
      {
        path: "src/ratelimit.ts",
        before: `export function allow(key: string): boolean {\n  return true;\n}\n`,
        after: `export function allow(key: string): boolean {\n  if (process.env.NODE_ENV === "test") return true;\n  return false;\n}\n`,
      },
    ]);
    const f = findings.find((x) => x.ruleId === "test-only-production-path");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
  });

  it("stays silent for an unrelated env flag", async () => {
    const findings = await scan([
      {
        path: "src/logger.ts",
        before: `export function level(): string {\n  return "info";\n}\n`,
        after: `export function level(): string {\n  return process.env.LOG_LEVEL ?? "info";\n}\n`,
      },
    ]);
    expect(ruleIds(findings)).not.toContain("test-only-production-path");
  });
});

describe("coverage-ignore-added", () => {
  it("reports a new istanbul ignore pragma", async () => {
    const findings = await scan([
      {
        path: "src/config.ts",
        before: `export function parse(s: string) {\n  return JSON.parse(s);\n}\n`,
        after: `export function parse(s: string) {\n  /* istanbul ignore next */\n  try { return JSON.parse(s); } catch { throw new Error("bad"); }\n}\n`,
      },
    ]);
    expect(ruleIds(findings)).toContain("coverage-ignore-added");
  });
});

describe("exception-broadened", () => {
  it("reports a specific error class becoming a bare toThrow", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(() => thing()).toThrow(InsufficientFunds);`),
        after: wrap(`    expect(() => thing()).toThrow();`),
      },
    ]);
    expect(ruleIds(findings)).toContain("exception-broadened");
  });

  it("stays silent when the error expectation becomes more specific", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(() => thing()).toThrow();`),
        after: wrap(`    expect(() => thing()).toThrow(ValidationError);`),
      },
    ]);
    expect(ruleIds(findings)).not.toContain("exception-broadened");
  });
});

describe("snapshot-replaced-assertion", () => {
  it("reports value assertions traded for a snapshot", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(
          `    const r = thing();\n    expect(r.header).toBe("Invoice");\n    expect(r.total).toBe(10);`,
        ),
        after: wrap(`    const r = thing();\n    expect(r).toMatchSnapshot();`),
      },
    ]);
    expect(ruleIds(findings)).toContain("snapshot-replaced-assertion");
  });

  it("stays silent when a snapshot is added alongside existing assertions", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    const r = thing();\n    expect(r.header).toBe("Invoice");`),
        after: wrap(
          `    const r = thing();\n    expect(r.header).toBe("Invoice");\n    expect(r).toMatchSnapshot();`,
        ),
      },
    ]);
    expect(ruleIds(findings)).not.toContain("snapshot-replaced-assertion");
  });
});

describe("mock-scope-expanded", () => {
  it("reports a test that starts mocking its own subject", async () => {
    const findings = await scan([
      {
        path: "src/shipping.test.ts",
        before: `import { it, expect } from "vitest";\nimport { estimate } from "./shipping.ts";\nit("a", () => { expect(estimate({})).toBe(4.5); });\n`,
        after: `import { it, expect, vi } from "vitest";\nimport { estimate } from "./shipping.ts";\nvi.mock("./shipping.ts", () => ({ estimate: vi.fn(() => 4.5) }));\nit("a", () => { expect(estimate({})).toBe(4.5); });\n`,
      },
      { path: "src/shipping.ts", before: "export const estimate = (p) => 4.5;\n", after: "export const estimate = (p) => 4.6;\n" },
    ]);
    expect(ruleIds(findings)).toContain("mock-scope-expanded");
  });

  it("stays silent when a dependency rather than the subject is mocked", async () => {
    const findings = await scan([
      {
        path: "src/report.test.ts",
        before: `import { it, expect } from "vitest";\nimport { buildReport } from "./report.ts";\nit("a", () => { expect(buildReport([])).toBe(0); });\n`,
        after: `import { it, expect, vi } from "vitest";\nimport { buildReport } from "./report.ts";\nvi.mock("./clock.ts", () => ({ now: () => 1 }));\nit("a", () => { expect(buildReport([])).toBe(0); });\n`,
      },
      { path: "src/report.ts", before: "export const buildReport = (r) => 0;\n", after: "export const buildReport = (r) => 1;\n" },
    ]);
    expect(ruleIds(findings)).not.toContain("mock-scope-expanded");
  });
});

// ---------------------------------------------------------------------------
// engine invariants
// ---------------------------------------------------------------------------

describe("engine", () => {
  it("emits no findings for an empty changeset", async () => {
    expect(await scan([])).toEqual([]);
  });

  it("never reports the `error` class, only review or evidence", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(401);`),
        after: wrap(`    expect(thing()).toBeDefined();`),
      },
    ]);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(["review", "evidence"]).toContain(f.class);
  });

  it("gives every finding a file, a line and a confidence", async () => {
    const findings = await scan([
      {
        path: "src/subject.test.ts",
        before: wrap(`    expect(thing()).toBe(401);`),
        after: wrap(`    expect(thing()).toBeDefined();`),
      },
    ]);
    for (const f of findings) {
      expect(f.file.length).toBeGreaterThan(0);
      expect(f.line).toBeGreaterThan(0);
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  it("does not crash on an unparseable test file", async () => {
    const findings = await scan([
      { path: "src/broken.test.ts", before: `it("a", () => { expect(1).toBe(1); });`, after: `it("a", () => { expect(` },
    ]);
    expect(findings.every((f) => f.ruleId !== "internal-rule-error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// path classification
// ---------------------------------------------------------------------------

describe("classifyPath", () => {
  it("recognises the conventional suffixes", () => {
    expect(classifyPath("src/auth.test.ts")).toBe("test");
    expect(classifyPath("src/auth.spec.tsx")).toBe("test");
    expect(classifyPath("tests/vanilla/basic.test.ts")).toBe("test");
    expect(classifyPath("tests/test_sessions.py")).toBe("test");
    expect(classifyPath("app/sessions_test.py")).toBe("test");
  });

  it("REGRESSION (immer): treats plain file names inside __tests__ as tests", () => {
    // immer keeps its whole suite in `__tests__/base.js`. Requiring a `.test.`
    // infix reported zero analysable commits for the entire repository.
    expect(classifyPath("__tests__/base.js")).toBe("test");
    expect(classifyPath("packages/core/__tests__/produce.ts")).toBe("test");
  });

  it("still excludes helpers inside test directories", () => {
    expect(classifyPath("__tests__/setup.ts")).toBe("other");
    expect(classifyPath("test/helpers/server.js")).toBe("other");
    expect(classifyPath("tests/utils.ts")).toBe("other");
  });

  it("treats ordinary source as production", () => {
    expect(classifyPath("src/auth.ts")).toBe("production");
    expect(classifyPath("lib/index.js")).toBe("production");
  });

  it("ignores non-source and generated files", () => {
    expect(classifyPath("README.md")).toBe("other");
    expect(classifyPath("src/types.d.ts")).toBe("other");
    expect(classifyPath("src/__snapshots__/a.snap")).toBe("other");
    expect(classifyPath("vitest.config.ts")).toBe("other");
  });
});
