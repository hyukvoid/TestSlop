/**
 * Tests for the assertion strength lattice.
 *
 * The lattice is the load-bearing abstraction in TestSlop: every diff-aware rule
 * reduces to "did the rank go down?". These tests pin the orderings that the
 * rules depend on, including the two that a naive implementation gets wrong
 * (toBeNull is exact, negation is resolved per-matcher).
 */

import { describe, expect, it } from "vitest";
import { classifyMatcher, isInteractionMatcher, isSnapshotMatcher } from "../src/adapters/ts/strength.ts";
import { STRENGTH_ORDER, strengthRank } from "../src/core/types.ts";
import type { AssertionArg } from "../src/core/types.ts";

const num = (n: number): AssertionArg => ({ raw: String(n), kind: "number", numeric: n });
const str = (s: string): AssertionArg => ({ raw: `"${s}"`, kind: "string", string: s });
const ident = (s: string): AssertionArg => ({ raw: s, kind: "identifier" });
const obj = (raw: string): AssertionArg => ({ raw, kind: "object" });
const expr = (raw: string): AssertionArg => ({ raw, kind: "expression" });

const rank = (matcher: string, args: AssertionArg[] = [], negated = false): number =>
  strengthRank(classifyMatcher(matcher, args, negated).strength);

describe("strength lattice ordering", () => {
  it("orders the classes from weakest to strongest", () => {
    expect(STRENGTH_ORDER).toEqual([
      "NONE",
      "VACUOUS",
      "OPAQUE",
      "EXISTENCE",
      "TYPE_ONLY",
      "CONSTRAINED",
      "STRUCTURAL",
      "EXACT",
    ]);
  });

  it("ranks an exact value above an existence check", () => {
    expect(rank("toBe", [num(401)])).toBeGreaterThan(rank("toBeDefined"));
  });

  it("ranks a type check above an existence check", () => {
    expect(rank("toBeInstanceOf", [ident("Error")])).toBeGreaterThan(rank("toBeDefined"));
  });

  it("ranks a structural check above a type check", () => {
    expect(rank("toMatchObject", [obj("{ a: 1 }")])).toBeGreaterThan(rank("toBeInstanceOf", [ident("Error")]));
  });

  it("ranks a snapshot below an existence check", () => {
    expect(rank("toMatchSnapshot")).toBeLessThan(rank("toBeDefined"));
  });
});

describe("matchers that pin exactly one value", () => {
  // The trap: toBeNull looks like the toBeDefined family but behaves like
  // toBe(null). Treating it as an existence check would report a strengthening
  // as a weakening.
  it.each(["toBeNull", "toBeUndefined", "toBeNaN"])("treats %s as EXACT", (matcher) => {
    expect(classifyMatcher(matcher, [], false).strength).toBe("EXACT");
  });

  it("treats toBe with a literal as EXACT", () => {
    expect(classifyMatcher("toBe", [num(3)], false).strength).toBe("EXACT");
  });

  it("treats toEqual with an object literal as EXACT", () => {
    expect(classifyMatcher("toEqual", [obj("{ ok: true }")], false).strength).toBe("EXACT");
  });
});

describe("existence and truthiness", () => {
  it.each(["toBeDefined", "toBeTruthy", "toBeFalsy"])("treats %s as EXISTENCE", (matcher) => {
    expect(classifyMatcher(matcher, [], false).strength).toBe("EXISTENCE");
  });
});

describe("negation is resolved per matcher, not by flipping a score", () => {
  it("makes not.toBe nearly vacuous", () => {
    expect(classifyMatcher("toBe", [num(3)], true).strength).toBe("VACUOUS");
  });

  it("makes not.toBeNull an existence check", () => {
    expect(classifyMatcher("toBeNull", [], true).strength).toBe("EXISTENCE");
  });

  it("makes not.toThrow an existence check rather than an error check", () => {
    const cls = classifyMatcher("toThrow", [], true);
    expect(cls.strength).toBe("EXISTENCE");
    expect(cls.aspect).toBe("error");
  });

  it("detects the weakening from toBe(true) to not.toBe(false)", () => {
    // Observed in zustand: `expect(shallow(a, b)).not.toBe(false)` where
    // `.toBe(true)` was meant.
    expect(rank("toBe", [{ raw: "false", kind: "boolean" }], true)).toBeLessThan(
      rank("toBe", [{ raw: "true", kind: "boolean" }], false),
    );
  });
});

describe("error assertions", () => {
  it("ranks a bare toThrow as EXISTENCE", () => {
    expect(classifyMatcher("toThrow", [], false).strength).toBe("EXISTENCE");
  });

  it("ranks toThrow(Error) as TYPE_ONLY, weaker than a specific class", () => {
    expect(classifyMatcher("toThrow", [ident("Error")], false).strength).toBe("TYPE_ONLY");
  });

  it("ranks toThrow with a message as CONSTRAINED", () => {
    expect(classifyMatcher("toThrow", [str("nope")], false).strength).toBe("CONSTRAINED");
  });

  it("orders bare < Error < message", () => {
    expect(rank("toThrow")).toBeLessThanOrEqual(rank("toThrow", [ident("Error")]));
    expect(rank("toThrow", [ident("Error")])).toBeLessThan(rank("toThrow", [str("boom")]));
  });
});

describe("interaction assertions", () => {
  it("classifies call tracking as the interaction aspect", () => {
    expect(classifyMatcher("toHaveBeenCalled", [], false).aspect).toBe("interaction");
    expect(isInteractionMatcher("toHaveBeenCalledWith")).toBe(true);
    expect(isInteractionMatcher("toBe")).toBe(false);
  });

  it("ranks toHaveBeenCalledWith(literals) above a bare toHaveBeenCalled", () => {
    expect(rank("toHaveBeenCalledWith", [str("a"), num(1)])).toBeGreaterThan(rank("toHaveBeenCalled"));
  });

  it("treats a call count as CONSTRAINED", () => {
    expect(classifyMatcher("toHaveBeenCalledTimes", [num(2)], false).strength).toBe("CONSTRAINED");
  });
});

describe("loose argument matchers downgrade an otherwise exact assertion", () => {
  it("downgrades toEqual containing expect.any to TYPE_ONLY", () => {
    expect(classifyMatcher("toEqual", [expr("{ id: expect.any(String) }")], false).strength).toBe("TYPE_ONLY");
  });

  it("downgrades toEqual containing objectContaining to STRUCTURAL", () => {
    expect(classifyMatcher("toEqual", [expr("expect.objectContaining({ a: 1 })")], false).strength).toBe("STRUCTURAL");
  });
});

describe("partial checks", () => {
  it("treats toHaveProperty without a value as an existence check", () => {
    expect(classifyMatcher("toHaveProperty", [str("a")], false).strength).toBe("EXISTENCE");
  });

  it("treats toHaveProperty with a value as structural", () => {
    expect(classifyMatcher("toHaveProperty", [str("a"), num(1)], false).strength).toBe("STRUCTURAL");
  });

  it("recognises snapshot matchers", () => {
    expect(isSnapshotMatcher("toMatchSnapshot")).toBe(true);
    expect(isSnapshotMatcher("toMatchInlineSnapshot")).toBe(true);
    expect(isSnapshotMatcher("toBe")).toBe(false);
  });

  it("treats an inline snapshot with content as stronger than a file snapshot", () => {
    expect(rank("toMatchInlineSnapshot", [str("{ a: 1 }")])).toBeGreaterThan(rank("toMatchSnapshot"));
  });
});

describe("every matcher yields prose describing what it still accepts", () => {
  it.each([
    "toBe",
    "toBeDefined",
    "toThrow",
    "toHaveBeenCalled",
    "toMatchSnapshot",
    "toBeInstanceOf",
    "toContain",
  ])("%s has a non-empty admits description", (matcher) => {
    const cls = classifyMatcher(matcher, [], false);
    expect(cls.admits.length).toBeGreaterThan(0);
  });
});
