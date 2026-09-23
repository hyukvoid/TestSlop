/**
 * Behavioural-alternative generation tests.
 *
 * The regression corpus for POC-02's central claim: that keying on the *distinguishing
 * input* rather than on the edit removes the largest noise category found in POC-01.
 *
 * Every case that references a POC-01 task is a real survivor from
 * corpus/equivalence-taxonomy.ts.
 */

import { describe, expect, it } from "vitest";
import { generateAlternatives, applyAlternative } from "../src/mutation/behaviour.ts";
import type { BehaviouralAlternative } from "../src/mutation/behaviour.ts";

function gen(src: string, lines: number[] = []): BehaviouralAlternative[] {
  return generateAlternatives("src/subject.ts", src, { lines });
}

function keys(alts: BehaviouralAlternative[]): string[] {
  return alts.map((a) => a.distinguishing.description);
}

// ---------------------------------------------------------------------------
// Comparisons: two probes, each with a nameable distinguishing input
// ---------------------------------------------------------------------------

describe("comparison thresholds", () => {
  const src = `export function reserve(quantity: number): boolean {
  if (quantity <= 0) {
    return false;
  }
  return true;
}
`;

  it("produces exactly two boundary probes", () => {
    const boundary = gen(src).filter((a) => a.kind === "boundary");
    expect(boundary).toHaveLength(2);
    expect(keys(boundary).sort()).toEqual(["quantity = 0", "quantity = 1"]);
  });

  it("names the input rather than the edit", () => {
    const past = gen(src).find((a) => a.distinguishing.description === "quantity = 1");
    expect(past).toBeDefined();
    // This is the POC-01 hero finding, now expressed in developer language.
    expect(past!.original).toBe("0");
    expect(past!.replacement).toBe("1");
    expect(past!.confidence).toBe("high");
    expect(past!.enclosing).toBe("reserve");
  });

  it("probes at the threshold by relaxing the operator", () => {
    const at = gen(src).find((a) => a.distinguishing.description === "quantity = 0");
    expect(at).toBeDefined();
    expect(at!.original).toBe("<=");
    expect(at!.replacement).toBe("<");
  });

  it("applies the edit correctly", () => {
    const past = gen(src).find((a) => a.distinguishing.description === "quantity = 1")!;
    expect(applyAlternative(src, past)).toContain("quantity <= 1");
  });

  it("collapses to one probe for a strict greater-than", () => {
    // `n > 10` relaxed is `n >= 10`; shifted is `n > 9`. Both differ only at n = 10, so
    // they are one finding.
    const g = `export function f(n: number) { return n > 10; }`;
    expect(keys(gen(g).filter((a) => a.kind === "boundary"))).toEqual(["n = 10"]);
  });
});

// ---------------------------------------------------------------------------
// Deduplication by distinguishing input: POC-01's largest noise category
// ---------------------------------------------------------------------------

describe("deduplication by distinguishing input", () => {
  it("REGRESSION (T20): `size < 1` yields one probe for size = 1, not two", () => {
    // POC-01 reported `< -> <=` and `1 -> 2` as separate survivors. They are the same
    // predicate change and the same missing input.
    const src = `export function normalise(size: number) {
  if (size !== undefined && size < 1) {
    throw new Error("bad size");
  }
  return size;
}
`;
    const forSizeOne = gen(src).filter((a) => a.distinguishing.description === "size = 1");
    expect(forSizeOne).toHaveLength(1);
  });

  it("REGRESSION (T14): `length > 3` yields one probe per distinct boundary value", () => {
    const src = `export function split(code: string) {
  return code.length > 3 ? code.slice(0, -3) : code;
}
`;
    const boundary = gen(src).filter((a) => a.kind === "boundary");
    const descriptions = keys(boundary);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    // POC-01 reported `> -> >=` and `3 -> 4` as two survivors here. Both differ only at
    // a 3-character postcode, so there is one finding.
    expect(descriptions).toEqual(["code.length = 3"]);
  });

  it("REGRESSION (T07): one gap inside a branch is not reported three times", () => {
    // POC-01 produced three survivors here: `0.5 -> 1.5`, `1 -> 2` and `+ -> -`, all
    // describing "no test uses a fraction strictly between 0.5 and 1".
    const src = `export function roundHalfToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) {
    return lower;
  }
  if (fraction > 0.5) {
    return lower + 1;
  }
  return lower % 2 === 0 ? lower : lower + 1;
}
`;
    const alts = gen(src);
    // The `lower + 1` arithmetic and constant probes collapse onto one key each, and
    // the report is driven by the comparison boundaries rather than by three edits.
    const uniqueKeys = new Set(alts.map((a) => a.distinguishing.key));
    expect(uniqueKeys.size).toBe(alts.length);
    // The fraction boundaries are present and named.
    expect(keys(alts)).toContain("fraction = 0.5");
  });
});

// ---------------------------------------------------------------------------
// Oblique sites: real differences a developer would not recognise
// ---------------------------------------------------------------------------

describe("oblique sites are not mutated", () => {
  it("REGRESSION (T01): a reduce() accumulator seed is skipped", () => {
    const src = `export function total(lines: Array<{ quantity: number }>): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}
`;
    const alts = gen(src);
    // The seed `0` must not become a finding: POC-01 reported it as "constant 0 -> 1",
    // which is a real behavioural change described in a way no developer connects to
    // "no test sits on a discount tier boundary".
    expect(alts.some((a) => a.kind === "constant" && a.original === "0")).toBe(false);
  });

  it("REGRESSION (T10): a `??` fallback default is skipped", () => {
    const src = `export function groupNet(map: Map<number, number>, rate: number): number {
  const current = map.get(rate) ?? 0;
  return current + 1;
}
`;
    const alts = gen(src);
    const seedMutated = alts.some((a) => a.line === 2 && a.original === "0");
    expect(seedMutated).toBe(false);
  });

  it("skips array indices, where mutation crashes rather than changing behaviour", () => {
    const src = `export function first(xs: number[]): number { return xs[0]; }`;
    expect(gen(src).some((a) => a.original === "0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Equality and coarse operators
// ---------------------------------------------------------------------------

describe("equality against a literal", () => {
  it("shifts the compared value rather than flipping the sense", () => {
    // Flipping `=== -> !==` differs for every input and cannot be named, which is what
    // produced POC-01's out-of-contract survivor (T05).
    const src = `export function isEmpty(n: number) { return n === 0; }`;
    const alts = gen(src);
    expect(alts.some((a) => a.replacement === "!==")).toBe(false);
    expect(keys(alts)).toContain("n = 0");
  });

  it("falls back to a low-confidence sense flip when there is no literal", () => {
    const src = `export function same(a: string, b: string) { return a === b; }`;
    const alts = gen(src);
    const flip = alts.find((a) => a.kind === "relation");
    expect(flip).toBeDefined();
    expect(flip!.confidence).toBe("low");
  });
});

describe("confidence reflects how nameable the distinguishing input is", () => {
  it("rates comparison boundaries high", () => {
    const src = `export function f(n: number) { return n >= 5; }`;
    for (const a of gen(src).filter((x) => x.kind === "boundary")) {
      expect(a.confidence).toBe("high");
    }
  });

  it("rates logical-operator swaps medium", () => {
    const src = `export function f(a: boolean, b: boolean) { return a && b; }`;
    const logic = gen(src).find((a) => a.kind === "logic");
    expect(logic).toBeDefined();
    expect(logic!.confidence).toBe("medium");
    expect(logic!.distinguishing.description).toMatch(/disagree/);
  });
});

// ---------------------------------------------------------------------------
// Scoping and safety
// ---------------------------------------------------------------------------

describe("line scoping", () => {
  const src = `export function a(n: number) { return n > 1; }
export function b(n: number) { return n > 2; }
`;

  it("restricts generation to the given lines", () => {
    const only = gen(src, [1]);
    expect(only.length).toBeGreaterThan(0);
    for (const a of only) expect(a.line).toBe(1);
  });

  it("considers the whole file when no lines are given", () => {
    expect(new Set(gen(src).map((a) => a.line))).toEqual(new Set([1, 2]));
  });
});

describe("string concatenation is not treated as arithmetic", () => {
  it("skips `+` between strings", () => {
    const src = `export function label(name: string) { return "hello " + name; }`;
    expect(gen(src).some((a) => a.kind === "arithmetic")).toBe(false);
  });
});

describe("every alternative is reportable", () => {
  it("carries a description, a key and a context", () => {
    const src = `export function withdraw(balance: number, amount: number) {
  if (amount > balance) return false;
  return balance - amount >= 0;
}
`;
    const alts = gen(src);
    expect(alts.length).toBeGreaterThan(0);
    for (const a of alts) {
      expect(a.distinguishing.description.length).toBeGreaterThan(0);
      expect(a.distinguishing.key.length).toBeGreaterThan(0);
      expect(a.context.length).toBeGreaterThan(0);
      expect(a.line).toBeGreaterThan(0);
      expect(a.end).toBeGreaterThan(a.start);
    }
  });
});

// ---------------------------------------------------------------------------
// Distinguishing-input arithmetic. The first implementation got two of the four
// operators wrong, reporting an off-by-one — the one number a developer checks first.
// ---------------------------------------------------------------------------

describe("the reported distinguishing value is actually where behaviour differs", () => {
  /** Brute-force check: the two predicates must disagree at exactly the reported value. */
  function verifyClaim(op: string, k: number, mutatedLiteral: number, claimed: number): void {
    const predicate = (v: number, threshold: number): boolean => {
      switch (op) {
        case "<":
          return v < threshold;
        case "<=":
          return v <= threshold;
        case ">":
          return v > threshold;
        default:
          return v >= threshold;
      }
    };
    // Disagree at the claimed value...
    expect(predicate(claimed, k)).not.toBe(predicate(claimed, mutatedLiteral));
    // ...and agree everywhere else nearby.
    for (const v of [k - 3, k - 2, k - 1, k, k + 1, k + 2, k + 3]) {
      if (v === claimed) continue;
      expect(predicate(v, k)).toBe(predicate(v, mutatedLiteral));
    }
  }

  it.each([
    ["<", 600],
    ["<=", 0],
    [">", 3],
    [">=", 500],
  ])("every threshold-shift probe for `n %s %i` reports a value that really differs", (op, k) => {
    const src = `export function f(n: number) { return n ${op} ${k}; }`;
    const shifts = generateAlternatives("src/subject.ts", src, { lines: [] }).filter(
      (a) => a.kind === "boundary" && a.original === String(k),
    );
    // For strict operators the shift probe deduplicates against the relaxation probe, so
    // it may legitimately be absent. Whatever survives must be arithmetically honest.
    for (const shift of shifts) {
      verifyClaim(op, k, Number(shift.replacement), Number(shift.distinguishing.value));
    }
  });

  it("REGRESSION: `status < 600` reports status = 600, not 601", () => {
    const src = `export function retryable(status: number) { return status >= 500 && status < 600; }`;
    const values = generateAlternatives("src/subject.ts", src, { lines: [] })
      .filter((a) => a.kind === "boundary")
      .map((a) => a.distinguishing.description);
    expect(values).toContain("status = 600");
    expect(values).not.toContain("status = 601");
  });

  it("REGRESSION: `length > 3` reports length = 3, not 2", () => {
    const src = `export function f(s: string) { return s.length > 3; }`;
    const values = generateAlternatives("src/subject.ts", src, { lines: [] })
      .filter((a) => a.kind === "boundary")
      .map((a) => a.distinguishing.description);
    expect(values).toContain("s.length = 3");
    expect(values).not.toContain("s.length = 2");
  });

  it("collapses both probes into one for a strict operator", () => {
    // `x < 600` relaxed is `x <= 600`; shifted is `x < 601`. These are the same
    // predicate, so one finding, not two.
    const src = `export function f(n: number) { return n < 600; }`;
    const boundary = generateAlternatives("src/subject.ts", src, { lines: [] }).filter(
      (a) => a.kind === "boundary",
    );
    expect(boundary).toHaveLength(1);
    expect(boundary[0]!.distinguishing.description).toBe("n = 600");
  });

  it("keeps two distinct probes for a non-strict operator", () => {
    // `x <= 0` relaxed is `x < 0` (differs at 0); shifted is `x <= 1` (differs at 1).
    const src = `export function f(n: number) { return n <= 0; }`;
    const values = generateAlternatives("src/subject.ts", src, { lines: [] })
      .filter((a) => a.kind === "boundary")
      .map((a) => a.distinguishing.description)
      .sort();
    expect(values).toEqual(["n = 0", "n = 1"]);
  });

  it("does not print float noise for a fractional threshold", () => {
    const src = `export function f(n: number) { return n > 0.5; }`;
    for (const a of generateAlternatives("src/subject.ts", src, { lines: [] })) {
      expect(a.distinguishing.description).not.toMatch(/\d{6,}/);
    }
  });
});

describe("one expression yields one finding", () => {
  it("REGRESSION (T07): mutating `+` and mutating `1` in `lower + 1` collapse", () => {
    const src = `export function f(lower: number, fraction: number): number {
  if (fraction > 0.5) {
    return lower + 1;
  }
  return lower;
}
`;
    const onExpression = generateAlternatives("src/subject.ts", src, { lines: [3] });
    // POC-01 reported this as two survivors; POC-02's first pass still did, because the
    // keys differed by which token was edited.
    expect(onExpression).toHaveLength(1);
  });
});
