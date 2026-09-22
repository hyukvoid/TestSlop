/**
 * Pairing benchmark.
 *
 * Each case is a transformation applied to a test file, plus the pairing the
 * transformation *should* produce. The point is to measure the layered pairing
 * strategy against the transformations that occur in real diffs, including the
 * ones it must refuse to pair.
 *
 * "Must not pair" cases matter as much as "must pair": a wrong pairing invents a
 * before/after relationship and can manufacture a high-severity finding from two
 * unrelated tests.
 */

import { describe, expect, it } from "vitest";
import { parseTestFile } from "../src/adapters/ts/parse-test.ts";
import { pairTestCases, structuralSimilarity, bodyFingerprint } from "../src/core/pairing.ts";
import type { PairBasis } from "../src/core/pairing.ts";

function cases(src: string) {
  return parseTestFile("src/subject.test.ts", src).cases;
}

function pair(beforeSrc: string, afterSrc: string) {
  return pairTestCases(cases(beforeSrc), cases(afterSrc));
}

const HEAD = `import { describe, expect, it, vi } from "vitest";
import { authenticate, calculateTax } from "./subject.ts";
`;

// ---------------------------------------------------------------------------
// Transformations that must pair
// ---------------------------------------------------------------------------

describe("pairing: transformations that must be recognised", () => {
  it("pairs an unchanged test by exact title", () => {
    const src = `${HEAD}
describe("authenticate", () => {
  it("rejects a missing token", () => {
    const response = authenticate(undefined);
    expect(response.status).toBe(401);
  });
});
`;
    const r = pair(src, src);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.basis).toBe<PairBasis>("exact-title");
  });

  it("pairs a renamed test whose body is unchanged", () => {
    const body = `
    const response = authenticate(undefined);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("missing_token");`;
    const before = `${HEAD}
describe("authenticate", () => {
  it("rejects a missing token", () => {${body}
  });
});
`;
    const after = `${HEAD}
describe("authenticate", () => {
  it("returns 401 when no token is supplied", () => {${body}
  });
});
`;
    const r = pair(before, after);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.basis).toBe<PairBasis>("identical-body");
  });

  it("THE BLIND SPOT: pairs a test that was renamed AND weakened", () => {
    // This is the transformation POC-00 could not see. Title changed and the
    // matcher changed, so neither title matching nor body fingerprinting works.
    const before = `${HEAD}
describe("authenticate", () => {
  it("rejects a missing token", () => {
    const response = authenticate(undefined);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("missing_token");
  });

  it("accepts a good token", () => {
    const response = authenticate("good");
    expect(response.status).toBe(200);
  });
});
`;
    const after = `${HEAD}
describe("authenticate", () => {
  it("handles a request without a token", () => {
    const response = authenticate(undefined);
    expect(response.status).toBeDefined();
    expect(response.body.error).toBeTruthy();
  });

  it("accepts a good token", () => {
    const response = authenticate("good");
    expect(response.status).toBe(200);
  });
});
`;
    const r = pair(before, after);
    const renamed = r.pairs.find((p) => p.before.name === "rejects a missing token");
    expect(renamed).toBeDefined();
    expect(renamed!.after.name).toBe("handles a request without a token");
    expect(renamed!.basis).toBe<PairBasis>("structural");
  });

  it("pairs across a renamed describe block", () => {
    const body = `
    const response = authenticate(undefined);
    expect(response.status).toBe(401);`;
    const before = `${HEAD}
describe("authenticate()", () => {
  it("rejects a missing token", () => {${body}
  });
});
`;
    const after = `${HEAD}
describe("the authenticate function", () => {
  it("rejects a missing token", () => {${body}
  });
});
`;
    const r = pair(before, after);
    expect(r.pairs).toHaveLength(1);
    // Identical body wins before leaf-title, and both are correct here.
    expect(["identical-body", "leaf-title"]).toContain(r.pairs[0]!.basis);
  });

  it("pairs when a describe block gains a nesting level", () => {
    const inner = `
  it("rejects a missing token", () => {
    const response = authenticate(undefined);
    expect(response.status).toBe(401);
  });`;
    const before = `${HEAD}\ndescribe("auth", () => {${inner}\n});\n`;
    const after = `${HEAD}\ndescribe("auth", () => {\n  describe("tokens", () => {${inner}\n  });\n});\n`;
    const r = pair(before, after);
    expect(r.pairs).toHaveLength(1);
    expect(r.removed).toHaveLength(0);
    expect(r.added).toHaveLength(0);
  });

  it("pairs a test with a minor body edit and a weakened assertion", () => {
    const before = `${HEAD}
describe("tax", () => {
  it("applies the standard rate", () => {
    const order = { subtotal: 1000, shipping: 0 };
    expect(calculateTax(order)).toBe(120);
  });

  it("ignores shipping", () => {
    expect(calculateTax({ subtotal: 500, shipping: 99 })).toBe(60);
  });
});
`;
    const after = `${HEAD}
describe("tax", () => {
  it("applies the configured rate", () => {
    const order = { subtotal: 1000, shipping: 0, currency: "EUR" };
    expect(calculateTax(order)).toBeGreaterThan(0);
  });

  it("ignores shipping", () => {
    expect(calculateTax({ subtotal: 500, shipping: 99 })).toBe(60);
  });
});
`;
    const r = pair(before, after);
    const p = r.pairs.find((x) => x.before.name === "applies the standard rate");
    expect(p).toBeDefined();
    expect(p!.after.name).toBe("applies the configured rate");
  });

  it("pairs a single renamed test in a two-test file via the singleton layer", () => {
    const before = `${HEAD}
it("a", () => { expect(authenticate("x").status).toBe(200); });
it("kept", () => { expect(calculateTax({ subtotal: 1 })).toBe(0); });
`;
    const after = `${HEAD}
it("totally different name", () => { expect(authenticate("x").status).toBeDefined(); });
it("kept", () => { expect(calculateTax({ subtotal: 1 })).toBe(0); });
`;
    const r = pair(before, after);
    const p = r.pairs.find((x) => x.before.name === "a");
    expect(p).toBeDefined();
    expect(["structural", "singleton"]).toContain(p!.basis);
  });
});

// ---------------------------------------------------------------------------
// Transformations that must NOT pair
// ---------------------------------------------------------------------------

describe("pairing: transformations that must be refused", () => {
  it("does not pair two unrelated tests", () => {
    const before = `${HEAD}
it("rejects a missing token", () => {
  const response = authenticate(undefined);
  expect(response.status).toBe(401);
});
`;
    const after = `${HEAD}
it("computes tax for a book order", () => {
  expect(calculateTax({ subtotal: 2000, sku: "BOOK-1" })).toBe(140);
});
`;
    const r = pair(before, after);
    // A two-case file could tempt the singleton layer; the subjects and calls
    // share nothing, so the score must stay below its floor.
    expect(r.pairs).toHaveLength(0);
    expect(r.removed).toHaveLength(1);
    expect(r.added).toHaveLength(1);
  });

  it("does not pair one removed test against one of several similar candidates", () => {
    // Parameterised-looking suite: several near-identical tests. Pairing the
    // removed one against any of them would be a guess.
    const t = (n: string) => `
it("case ${n}", () => {
  const response = authenticate("tok${n}");
  expect(response.status).toBe(200);
});`;
    const before = `${HEAD}${t("1")}${t("2")}${t("3")}${t("4")}`;
    const after = `${HEAD}${t("1")}${t("2")}${t("3")}`;
    const r = pair(before, after);
    expect(r.pairs).toHaveLength(3);
    for (const p of r.pairs) expect(p.basis).toBe<PairBasis>("exact-title");
    expect(r.removed.map((c) => c.name)).toEqual(["case 4"]);
    expect(r.added).toHaveLength(0);
  });

  it("keeps duplicate full titles stable and total", () => {
    // immer's `base functionality - ${name}` pattern produces several test cases
    // that share one template-literal title. The layer-1 queue must consume them
    // in order so the mapping is total and stable rather than collapsing onto one.
    const t = (suite: string) => `
describe("${suite}", () => {
  it(\`does the thing - \${name}\`, () => {
    expect(authenticate("x").status).toBe(200);
  });
});`;
    // Same describe name three times: three cases, one identical fullName.
    const src = `${HEAD}${t("suite")}${t("suite")}${t("suite")}`;
    const r = pair(src, src);
    expect(r.pairs).toHaveLength(3);
    expect(r.removed).toHaveLength(0);
    expect(r.added).toHaveLength(0);
    for (const p of r.pairs) expect(p.basis).toBe<PairBasis>("exact-title");
  });

  it("KNOWN LIMITATION: a suite generated by a runtime loop parses as one case", () => {
    // Documented rather than fixed. The adapter is syntactic and never executes
    // the file, so `for (const name of [...]) { it(...) }` yields a single test
    // case regardless of how many the runner will produce. Pairing is therefore
    // correct but the *count* is not, which matters only for the changed-test
    // tally in the summary, not for any rule's verdict.
    const src = `${HEAD}
for (const name of ["proxy", "es5", "map"]) {
  it(\`does the thing - \${name}\`, () => {
    expect(authenticate("x").status).toBe(200);
  });
}
`;
    expect(cases(src)).toHaveLength(1);
    const r = pair(src, src);
    expect(r.pairs).toHaveLength(1);
  });

  it("treats a test split into two as one pair plus one addition, not two pairs", () => {
    const before = `${HEAD}
it("normalises everything", () => {
  const r = authenticate("x");
  expect(r.status).toBe(200);
  expect(r.body.userId).toBe("u1");
});
`;
    const after = `${HEAD}
it("normalises everything", () => {
  const r = authenticate("x");
  expect(r.status).toBe(200);
});

it("returns the user id", () => {
  const r = authenticate("x");
  expect(r.body.userId).toBe("u1");
});
`;
    const r = pair(before, after);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.basis).toBe<PairBasis>("exact-title");
    expect(r.added.map((c) => c.name)).toEqual(["returns the user id"]);
  });

  it("does not pair when two removed tests both plausibly match one addition", () => {
    const before = `${HEAD}
it("alpha", () => { const r = authenticate("x"); expect(r.status).toBe(200); });
it("beta", () => { const r = authenticate("x"); expect(r.status).toBe(201); });
it("gamma", () => { expect(calculateTax({ subtotal: 5 })).toBe(1); });
`;
    const after = `${HEAD}
it("renamed", () => { const r = authenticate("x"); expect(r.status).toBeDefined(); });
it("gamma", () => { expect(calculateTax({ subtotal: 5 })).toBe(1); });
`;
    const r = pair(before, after);
    // alpha and beta are equally similar to `renamed`, so the margin rule must
    // refuse rather than pick one arbitrarily.
    const ambiguous = r.pairs.find((p) => p.after.name === "renamed");
    expect(ambiguous).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

describe("bodyFingerprint", () => {
  it("ignores whitespace, comments and case", () => {
    const a = bodyFingerprint(`() => {\n  // note\n  expect(X).toBe(1);\n}`);
    const b = bodyFingerprint(`() => { /* other */ expect(x).toBe(1); }`);
    expect(a).toBe(b);
  });

  it("distinguishes different expected values", () => {
    expect(bodyFingerprint("expect(x).toBe(1)")).not.toBe(bodyFingerprint("expect(x).toBe(2)"));
  });
});

describe("structuralSimilarity", () => {
  it("scores a weakened version of the same test highly", () => {
    const [a] = cases(`${HEAD}\nit("x", () => { const r = authenticate(undefined); expect(r.status).toBe(401); });`);
    const [b] = cases(`${HEAD}\nit("y", () => { const r = authenticate(undefined); expect(r.status).toBeDefined(); });`);
    expect(structuralSimilarity(a!, b!)).toBeGreaterThan(0.6);
  });

  it("scores unrelated tests low", () => {
    const [a] = cases(`${HEAD}\nit("x", () => { const r = authenticate(undefined); expect(r.status).toBe(401); });`);
    const [b] = cases(`${HEAD}\nit("y", () => { expect(calculateTax({ subtotal: 9 })).toBe(1); });`);
    expect(structuralSimilarity(a!, b!)).toBeLessThan(0.3);
  });
});
