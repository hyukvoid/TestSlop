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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { collectChangeSet } from "../src/core/changeset.ts";
import { generateAlternatives, applyAlternative } from "../src/mutation/behaviour.ts";
import type { BehaviouralAlternative } from "../src/mutation/behaviour.ts";
import { verifyChangedBehaviour } from "../src/mutation/behaviour-verify.ts";

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

// ---------------------------------------------------------------------------
// Sandbox correctness
// ---------------------------------------------------------------------------

describe("sandbox", () => {
  it("REGRESSION: a reused sandbox does not keep files the new revision lacks", async () => {
    // Found by running the external-history harness twice: it reuses one worktree path
    // for every commit, and a stale test file from the previous commit stayed in the
    // sandbox and kept killing mutants. The same 18 commits reported 2 unverified
    // behaviours on one run and 0 on the next.
    const { createSandbox } = await import("../src/mutation/sandbox.ts");
    const { mkdtemp, mkdir, writeFile, rm, readdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");

    const source = await mkdtemp(nodePath.join(os.tmpdir(), "testslop-src-"));
    await mkdir(nodePath.join(source, "src"), { recursive: true });
    await writeFile(nodePath.join(source, "src", "kept.ts"), "export const a = 1;", "utf8");
    await writeFile(nodePath.join(source, "src", "removed.ts"), "export const b = 2;", "utf8");

    const first = await createSandbox(source);
    expect((await readdir(nodePath.join(first.root, "src"))).sort()).toEqual(["kept.ts", "removed.ts"]);

    // Simulate checking out a revision that no longer has one of the files.
    await rm(nodePath.join(source, "src", "removed.ts"), { force: true });

    const second = await createSandbox(source);
    expect(await readdir(nodePath.join(second.root, "src"))).toEqual(["kept.ts"]);

    await second.dispose();
    await rm(source, { recursive: true, force: true });
  });

  it("never writes to the analysed repository", async () => {
    const { createSandbox } = await import("../src/mutation/sandbox.ts");
    const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");

    const source = await mkdtemp(nodePath.join(os.tmpdir(), "testslop-src-"));
    await mkdir(nodePath.join(source, "src"), { recursive: true });
    const original = "export const threshold = 10;";
    await writeFile(nodePath.join(source, "src", "a.ts"), original, "utf8");

    const sandbox = await createSandbox(source, { reuse: false });
    await sandbox.write("src/a.ts", "export const threshold = 11;");

    // The mutation landed in the sandbox...
    expect(await sandbox.read("src/a.ts")).toContain("11");
    // ...and the developer's file is untouched.
    expect(await readFile(nodePath.join(source, "src", "a.ts"), "utf8")).toBe(original);

    await sandbox.dispose();
    await rm(source, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Applying an alternative to the wrong text
// ---------------------------------------------------------------------------

describe("applying an alternative", () => {
  it("REGRESSION: refuses to splice when the span no longer matches", () => {
    // The bug this prevents produced a fabricated external finding.
    //
    // Analysis reads changed files from the git blob (LF). On Windows with
    // `core.autocrlf=true` the file on disk is CRLF, one byte longer per line. Applying
    // blob offsets to the on-disk text put the edit ~150 characters early; on `bytes`
    // commit 6ec88d8 it overwrote the `/` of a `//` comment with `/`. Nothing changed,
    // every test passed, and the verifier reported unverified behaviour — a finding
    // manufactured by the tool doing nothing.
    const lf = [
      "export function toBytes(unit: number, value: number): number {",
      "  // Retrieve the value and the unit, then drop partial bytes.",
      "  return Math.floor(unit * value);",
      "}",
      "",
    ].join("\n");

    const alt = generateAlternatives("index.ts", lf, { lines: [3] })[0];
    expect(alt).toBeDefined();
    expect(applyAlternative(lf, alt!)).toContain("unit / value");

    const crlf = lf.replace(/\n/g, "\r\n");
    expect(() => applyAlternative(crlf, alt!)).toThrow(/no longer matches its source span/);
  });

  it("still applies when a numeric literal is spelled differently than parsed", () => {
    // `0x400` parses to the text "1024"; comparing spellings would reject a valid edit.
    const src = `export function f(n: number) { return n < 0x400; }`;
    const alts = generateAlternatives("src/a.ts", src, { lines: [1] });
    const shift = alts.find((a) => a.kind === "boundary" && /^\d/.test(a.original));
    if (shift) expect(() => applyAlternative(src, shift)).not.toThrow();
  });
});

describe("capability fallbacks are not behavioural alternatives", () => {
  it("REGRESSION (bytes 028f63ec): a polyfill fallback yields nothing", () => {
    // The only external commit that reported findings reported three, and all three were
    // about a `Number.isFinite` polyfill: the `||`, the `&&` inside the fallback body,
    // and the `===` inside it. On any runtime with the built-in, the fallback is dead
    // code, so no test can distinguish them.
    const src =
      `var numberIsFinite = Number.isFinite || function (v) { return typeof v === 'number' && isFinite(v); };\n`;
    expect(generateAlternatives("index.js", src, { lines: [1] })).toEqual([]);
  });

  it("still probes a genuine `||` inside a condition", () => {
    const src = `export function f(a: boolean, b: boolean) {\n  if (a || b) return 1;\n  return 0;\n}\n`;
    const alts = generateAlternatives("src/a.ts", src, { lines: [2] });
    expect(alts.map((a) => a.kind)).toContain("logic");
  });
});

describe("loop scaffolding and numeric bases", () => {
  it("REGRESSION (qs 0d415f34): a for-loop's counter, bound and radix yield nothing", () => {
    // Three of that commit's four findings were "i exactly equal to keys.length",
    // "any input that reaches `i = 0`" and a `parseInt(..., 10)` radix shift. All true,
    // none nameable as an input the developer can constrain.
    const src = `export function f(keys: string[], max: number) {
  for (var i = 0; i < keys.length; ++i) {
    var num = parseInt(keys[i], 10);
    if (num > max) max = num;
  }
  return max;
}
`;
    const alts = generateAlternatives("lib/utils.js", src, { lines: [2, 3] });
    expect(alts).toEqual([]);
  });

  it("still probes a comparison in a loop condition that is not the counter", () => {
    const src = `export function f(remaining: number, limit: number) {
  for (;remaining < limit;) { remaining += 1; }
  return remaining;
}
`;
    const alts = generateAlternatives("src/a.ts", src, { lines: [2] });
    expect(alts.some((a) => a.kind === "boundary")).toBe(true);
  });

  it("still probes a guard inside the loop body", () => {
    const src = `export function f(keys: number[]) {
  for (var i = 0; i < keys.length; ++i) {
    if (keys[i] > 100) return true;
  }
  return false;
}
`;
    const alts = generateAlternatives("src/a.ts", src, { lines: [3] });
    expect(alts.some((a) => a.distinguishing.description.includes("100"))).toBe(true);
  });
});

describe("dependency linking", () => {
  it("links a dependency tree from outside the analysed directory", async () => {
    // The reason this option exists: a `node_modules` junction placed inside a git
    // worktree was destroyed — along with the real repository's dependencies — by
    // `git worktree remove --force`, which deletes through a junction. Every baseline
    // after the first commit went red and the harness reported that as a fact about the
    // repository rather than as its own damage.
    const { createSandbox } = await import("../src/mutation/sandbox.ts");
    const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");

    const deps = await mkdtemp(nodePath.join(os.tmpdir(), "testslop-deps-"));
    await mkdir(nodePath.join(deps, "left-pad"), { recursive: true });
    await writeFile(nodePath.join(deps, "left-pad", "index.js"), "module.exports = 1;", "utf8");

    const source = await mkdtemp(nodePath.join(os.tmpdir(), "testslop-src-"));
    await writeFile(nodePath.join(source, "a.js"), "module.exports = 2;", "utf8");

    const sandbox = await createSandbox(source, { reuse: false, modulesFrom: deps });
    const linked = await readFile(
      nodePath.join(sandbox.root, "node_modules", "left-pad", "index.js"),
      "utf8",
    );
    expect(linked).toContain("module.exports = 1;");

    await sandbox.dispose();
    // Disposing the sandbox must not reach through the link.
    expect(await readFile(nodePath.join(deps, "left-pad", "index.js"), "utf8")).toContain("= 1;");

    await rm(deps, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });
});

describe("string building is never arithmetic", () => {
  it("REGRESSION (qs 963e538c): a chained concatenation offers no `-` alternative", () => {
    const src = `export function message(limit: number): string {
  return "Array limit exceeded. Only " + limit + " element" + (limit === 1 ? "" : "s") + " allowed.";
}
`;
    const alts = generateAlternatives("lib/utils.js", src, { lines: [2] });
    expect(alts.filter((a) => a.kind === "arithmetic")).toEqual([]);
  });

  it("still offers `-` for real arithmetic", () => {
    const src = `export function f(available: number, wanted: number) { return available - wanted; }`;
    const alts = generateAlternatives("src/a.ts", src, { lines: [1] });
    expect(alts.some((a) => a.kind === "arithmetic")).toBe(true);
  });
});

describe("provable equivalences are never reported", () => {
  it("REGRESSION (qs 0d415f34): an idempotent update guard is skipped", () => {
    // `if (num > max) { max = num; }` — relaxing `>` only adds num === max, where the
    // body assigns max the value it already has. No test can ever kill it.
    const src = `export function maxIndex(keys: number[], min: number): number {
  var max = min;
  for (var i = 0; i < keys.length; ++i) {
    var num = keys[i];
    if (num > max) {
      max = num;
    }
  }
  return max;
}
`;
    const alts = generateAlternatives("lib/utils.js", src, { lines: [5] });
    expect(alts).toEqual([]);
  });

  it("still probes an update guard that does more than assign", () => {
    const src = `export function f(num: number, max: number, log: number[]): number {
  if (num > max) {
    max = num;
    log.push(num);
  }
  return max;
}
`;
    const alts = generateAlternatives("src/a.ts", src, { lines: [2] });
    expect(alts.some((a) => a.kind === "boundary")).toBe(true);
  });

  it("REGRESSION (camelcase 552b7f1d): a seed for a reassigned variable is skipped", () => {
    const src = `export function f(input: string): string {
  let previousWasUppercase = false;
  let out = "";
  for (const ch of input) {
    out += previousWasUppercase ? ch.toLowerCase() : ch;
    previousWasUppercase = ch === ch.toUpperCase();
  }
  return out;
}
`;
    const alts = generateAlternatives("index.js", src, { lines: [2] });
    expect(alts).toEqual([]);
  });

  it("still probes a constant that is never reassigned", () => {
    const src = `export function f(n: number): boolean {
  const LIMIT = 100;
  return n > LIMIT;
}
`;
    const alts = generateAlternatives("src/a.ts", src, { lines: [2] });
    expect(alts.some((a) => a.original === "100")).toBe(true);
  });
});

describe("baseline fallback", () => {
  it("uses the full suite when a targeted run fails a global check", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const source = await mkdtemp(nodePath.join(os.tmpdir(), "testslop-baseline-"));
    const scratchHash = createHash("sha1").update(nodePath.resolve(source)).digest("hex").slice(0, 12);
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: source, stdio: "ignore" });
    };

    try {
      await mkdir(nodePath.join(source, "src"), { recursive: true });
      await mkdir(nodePath.join(source, "test"), { recursive: true });
      await writeFile(
        nodePath.join(source, "package.json"),
        JSON.stringify({ private: true, devDependencies: { jest: "0" } }),
        "utf8",
      );
      await writeFile(
        nodePath.join(source, "src", "subject.ts"),
        "export function reserve(quantity: number): boolean {\n  return quantity > 0;\n}\n",
        "utf8",
      );
      await writeFile(nodePath.join(source, "test", "subject.test.ts"), "// original test\n", "utf8");
      await writeFile(
        nodePath.join(source, "check-suite.cjs"),
        [
          'const fs = require("node:fs");',
          "if (process.argv.length > 2) process.exit(1);",
          'const text = fs.readFileSync("src/subject.ts", "utf8");',
          'process.exit(text.includes("quantity >= 0") ? 0 : 1);',
        ].join("\n"),
        "utf8",
      );

      git(["init", "-q", "-b", "main"]);
      git(["config", "user.name", "TestSlop regression"]);
      git(["config", "user.email", "testslop-regression@example.invalid"]);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "baseline"]);

      await writeFile(
        nodePath.join(source, "src", "subject.ts"),
        "export function reserve(quantity: number): boolean {\n  return quantity >= 0;\n}\n",
        "utf8",
      );
      await writeFile(nodePath.join(source, "test", "subject.test.ts"), "// added test\n", "utf8");

      const changeSet = await collectChangeSet({ cwd: source, base: "HEAD" });
      const report = await verifyChangedBehaviour(changeSet, {
        budget: 4,
        timeoutMs: 30_000,
        testCommand: "node check-suite.cjs",
        validateLinking: false,
      });

      expect(report.baseline.ok).toBe(true);
      expect(report.testCommand).toBe("node check-suite.cjs");
      expect(report.counts.executed).toBeGreaterThan(0);
      expect(report.counts.caught).toBe(report.counts.executed);
      expect(report.results.every((result) => result.testedWith[0] === "<full suite>")).toBe(true);
    } finally {
      await rm(nodePath.join(os.tmpdir(), "testslop-" + scratchHash), { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });
});
describe("junctioned dependency linking", () => {
  it("resolves nested node_modules junctions and preserves their source", async () => {
    const { createSandbox } = await import("../src/mutation/sandbox.ts");
    const { mkdtemp, mkdir, writeFile, readFile, rm, symlink } = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const deps = await mkdtemp(nodePath.join(os.tmpdir(), "testslop-real-deps-"));
    const source = await mkdtemp(nodePath.join(os.tmpdir(), "testslop-junction-src-"));
    const dependency = nodePath.join(deps, "jest-preset", "index.js");
    await mkdir(nodePath.dirname(dependency), { recursive: true });
    await writeFile(dependency, "module.exports = true;", "utf8");
    await symlink(deps, nodePath.join(source, "node_modules"), "junction");

    const sandbox = await createSandbox(source, { reuse: false });
    try {
      const sandboxCopy = await readFile(
        nodePath.join(sandbox.root, "node_modules", "jest-preset", "index.js"),
        "utf8",
      );
      expect(sandboxCopy).toBe("module.exports = true;");
    } finally {
      await sandbox.dispose();
    }

    try {
      expect(await readFile(dependency, "utf8")).toBe("module.exports = true;");
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(deps, { recursive: true, force: true });
    }
  });
});
