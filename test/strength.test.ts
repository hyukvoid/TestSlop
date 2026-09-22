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

describe("negated occurrence and absence claims are precise, not vacuous", () => {
  // These came out of the axios history, where nine findings were tests whose
  // entire contract was that something did not happen.
  it("REGRESSION (axios Http2Sessions): not.toHaveBeenCalled pins the call count to zero", () => {
    const cls = classifyMatcher("toHaveBeenCalled", [], true);
    expect(cls.strength).toBe("EXACT");
    expect(cls.aspect).toBe("interaction");
  });

  it("keeps not.toHaveBeenCalledWith weak, because it still admits any other call", () => {
    expect(classifyMatcher("toHaveBeenCalledWith", [str("a")], true).strength).toBe("VACUOUS");
  });

  it("REGRESSION (axios AxiosError): not.toHaveProperty is a precise absence claim", () => {
    expect(classifyMatcher("toHaveProperty", [str("cause")], true).strength).toBe("STRUCTURAL");
  });

  it("treats not.toBeDefined as equivalent to toBeUndefined", () => {
    expect(classifyMatcher("toBeDefined", [], true).strength).toBe("EXACT");
    expect(rank("toBeDefined", [], true)).toBe(rank("toBeUndefined"));
  });

  it("still treats not.toContain as weak", () => {
    expect(classifyMatcher("toContain", [str("x")], true).strength).toBe("VACUOUS");
  });

  it("REGRESSION (immer): a conditional of string literals is still a message expectation", () => {
    // `toThrowError(isProd ? "[Immer] minified error nr: 21" : "produce can only …")`
    const conditional: AssertionArg = {
      raw: 'isProd ? "[Immer] minified error nr: 21" : "produce can only be called on drafts"',
      kind: "string",
    };
    expect(classifyMatcher("toThrowError", [conditional], false).strength).toBe("CONSTRAINED");
  });
});

describe("reference identity vs value equality under negation", () => {
  // From immer's copy-semantics suite, where `not.toBe(ref)` is the correct and
  // intentional assertion that a copy was returned. Treating it as vacuous
  // produced three high-severity findings on correct code.
  it("REGRESSION (immer): not.toBe(objectReference) is a precise non-identity claim", () => {
    expect(classifyMatcher("toBe", [ident("base.w")], true).strength).toBe("CONSTRAINED");
    expect(classifyMatcher("toBe", [ident("draft")], true).strength).toBe("CONSTRAINED");
  });

  it("keeps not.toBe(literal) vacuous, because it admits every other value", () => {
    expect(classifyMatcher("toBe", [{ raw: "false", kind: "boolean" }], true).strength).toBe("VACUOUS");
    expect(classifyMatcher("toBe", [num(3)], true).strength).toBe("VACUOUS");
  });

  it("keeps not.toEqual weak even against a reference, since deep inequality is broad", () => {
    expect(classifyMatcher("toEqual", [ident("base")], true).strength).toBe("VACUOUS");
  });
});

describe("error-message snapshots are message assertions, not value snapshots", () => {
  it("REGRESSION (immer): an inline error snapshot is not stronger than an explicit message", () => {
    // immer replaced `toThrowErrorMatchingInlineSnapshot(...)` with
    // `toThrowError(isProd ? "…" : "…")`, an improvement that was being reported
    // as four separate weakenings.
    const snapshot = classifyMatcher("toThrowErrorMatchingInlineSnapshot", [str("boom")], false);
    const explicit = classifyMatcher("toThrowError", [str("boom")], false);
    expect(snapshot.aspect).toBe("error");
    expect(strengthRank(snapshot.strength)).toBeLessThanOrEqual(strengthRank(explicit.strength));
  });

  it("treats a file-based error snapshot as opaque", () => {
    expect(classifyMatcher("toThrowErrorMatchingSnapshot", [], false).strength).toBe("OPAQUE");
  });
});
