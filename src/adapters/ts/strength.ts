/**
 * Matcher classification for Jest / Vitest.
 *
 * The whole tool hinges on this table, so a note on the reasoning:
 *
 * An assertion is a predicate over program behaviour. Its *strength* is the
 * inverse of how much behaviour it still accepts. `toBe(401)` accepts one
 * value; `toBeDefined()` accepts everything except `undefined`. When an agent
 * rewrites the former into the latter, the test keeps its name, keeps its
 * coverage and keeps passing, while the oracle silently stops being able to
 * fail. That transition is what TestSlop is built to see.
 *
 * Two subtleties that a naive "score the matcher name" approach gets wrong and
 * that are handled here:
 *
 *  1. `toBeNull()` / `toBeUndefined()` / `toBeNaN()` are *exact* assertions,
 *     not existence assertions. They pin a single value. Only `toBeDefined()`
 *     and the truthiness family are existence checks.
 *
 *  2. Negation inverts the admitted set. `expect(x).not.toBe(3)` accepts every
 *     value except one, which is close to vacuous, whereas `not.toBeNull()`
 *     is a genuine existence check. So negation is resolved per-matcher rather
 *     than by flipping a score.
 */

import type { AssertionArg, AssertionAspect, StrengthClass } from "../../core/types.ts";

export interface MatcherClassification {
  strength: StrengthClass;
  aspect: AssertionAspect;
  /** Prose describing what the assertion still accepts. Used in reports. */
  admits: string;
}

const INTERACTION_MATCHERS = new Set([
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveBeenCalledOnce",
  "toHaveReturned",
  "toHaveReturnedTimes",
  "toHaveReturnedWith",
  "toHaveLastReturnedWith",
  "toHaveNthReturnedWith",
  "toHaveResolved",
  "toHaveResolvedTimes",
  "toHaveResolvedWith",
  // sinon / chai-style
  "called",
  "calledOnce",
  "calledWith",
  "calledWithExactly",
  "notCalled",
]);

const SNAPSHOT_MATCHERS = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toMatchFileSnapshot",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
]);

const ERROR_MATCHERS = new Set([
  "toThrow",
  "toThrowError",
  "rejects",
]);

/** Matchers that pin exactly one value, regardless of arguments. */
const EXACT_NULLARY = new Set(["toBeNull", "toBeUndefined", "toBeNaN"]);

/** Matchers that only rule out absence or falsiness. */
const EXISTENCE_NULLARY = new Set(["toBeDefined", "toBeTruthy", "toBeFalsy"]);

function isLiteralArg(arg: AssertionArg | undefined): boolean {
  if (!arg) return false;
  return (
    arg.kind === "number" ||
    arg.kind === "string" ||
    arg.kind === "boolean" ||
    arg.kind === "null" ||
    arg.kind === "undefined"
  );
}

/**
 * `expect.any(X)` / `expect.anything()` / `expect.objectContaining(...)` inside
 * an argument downgrade an otherwise exact assertion, because they replace a
 * concrete expectation with a type or partial-shape expectation.
 */
function argLooseness(args: AssertionArg[]): "none" | "type" | "partial" {
  const joined = args.map((a) => a.raw).join(",");
  if (/expect\s*\.\s*anything\s*\(/.test(joined)) return "type";
  if (/expect\s*\.\s*any\s*\(/.test(joined)) return "type";
  if (/expect\s*\.\s*(objectContaining|arrayContaining|stringContaining|stringMatching|closeTo)\s*\(/.test(joined)) {
    return "partial";
  }
  return "none";
}

export function classifyMatcher(
  matcher: string,
  args: AssertionArg[],
  negated: boolean,
): MatcherClassification {
  const looseness = argLooseness(args);

  // -- Interaction assertions -------------------------------------------------
  if (INTERACTION_MATCHERS.has(matcher)) {
    const withArgs =
      matcher === "toHaveBeenCalledWith" ||
      matcher === "toHaveBeenLastCalledWith" ||
      matcher === "toHaveBeenNthCalledWith" ||
      matcher === "calledWith" ||
      matcher === "calledWithExactly" ||
      matcher === "toHaveReturnedWith" ||
      matcher === "toHaveLastReturnedWith" ||
      matcher === "toHaveNthReturnedWith" ||
      matcher === "toHaveResolvedWith";

    if (negated) {
      // `expect(spy).not.toHaveBeenCalled()` is NOT a weak assertion: it pins the
      // call count to exactly zero, which is a precise and often complete
      // contract ("closing the session must not touch the socket").
      //
      // Negating a *specific* call is different — `not.toHaveBeenCalledWith(x)`
      // still admits every other call and no call at all — so the two are
      // separated rather than both being treated as negation.
      //
      // axios surfaced this: nine findings on lifecycle tests whose whole point
      // was asserting that something did not happen.
      if (!withArgs) {
        return {
          strength: "EXACT",
          aspect: "interaction",
          admits: "only behaviour in which the collaborator is never invoked",
        };
      }
      return {
        strength: "VACUOUS",
        aspect: "interaction",
        admits: "any call other than the one listed, including no call at all",
      };
    }
    if (withArgs && looseness === "none" && args.length > 0) {
      return {
        strength: "STRUCTURAL",
        aspect: "interaction",
        admits: "any behaviour that happens to call the collaborator with these arguments",
      };
    }
    if (withArgs) {
      return {
        strength: "TYPE_ONLY",
        aspect: "interaction",
        admits: "any call whose arguments loosely match",
      };
    }
    if (matcher === "toHaveBeenCalledTimes" || matcher === "toHaveReturnedTimes" || matcher === "toHaveResolvedTimes") {
      return {
        strength: "CONSTRAINED",
        aspect: "interaction",
        admits: "any behaviour with this call count, whatever the arguments or result",
      };
    }
    return {
      strength: "EXISTENCE",
      aspect: "interaction",
      admits: "any behaviour that invokes the collaborator at all",
    };
  }

  // -- Snapshots -------------------------------------------------------------
  if (SNAPSHOT_MATCHERS.has(matcher)) {
    const inline = matcher.includes("Inline") && args.length > 0;

    // An error-message snapshot is a message assertion whose text happens to be
    // tool-generated. Ranking it above an explicit `toThrowError("msg")` made
    // immer's migration to explicit messages look like four weakenings, when it
    // was an improvement.
    if (matcher.startsWith("toThrowError")) {
      return {
        strength: inline ? "CONSTRAINED" : "OPAQUE",
        aspect: "error",
        admits: inline
          ? "any error whose message matches the inline snapshot"
          : "any error, until the stored snapshot is regenerated",
      };
    }

    return {
      strength: inline ? "STRUCTURAL" : "OPAQUE",
      aspect: "snapshot",
      admits: inline
        ? "any value serialising to the inline snapshot"
        : "any value, until the stored snapshot is regenerated",
    };
  }

  // -- Error assertions ------------------------------------------------------
  if (ERROR_MATCHERS.has(matcher)) {
    if (negated) {
      return {
        strength: "EXISTENCE",
        aspect: "error",
        admits: "any behaviour that does not throw",
      };
    }
    const first = args[0];
    if (!first || first.kind === "none") {
      return {
        strength: "EXISTENCE",
        aspect: "error",
        admits: "any thrown value of any type with any message",
      };
    }
    if (first.kind === "string" || first.kind === "regexp") {
      return {
        strength: "CONSTRAINED",
        aspect: "error",
        admits: "any error whose message matches",
      };
    }
    // toThrow(SomeError) — a bare `Error` accepts essentially everything thrown.
    if (first.raw === "Error") {
      return {
        strength: "TYPE_ONLY",
        aspect: "error",
        admits: "any Error subclass with any message",
      };
    }
    return {
      strength: "TYPE_ONLY",
      aspect: "error",
      admits: `any ${first.raw} with any message`,
    };
  }

  // -- Nullary value matchers ------------------------------------------------
  if (EXACT_NULLARY.has(matcher)) {
    if (negated) {
      return {
        strength: "EXISTENCE",
        aspect: "value",
        admits: `any value other than ${matcher.replace("toBe", "").toLowerCase()}`,
      };
    }
    return { strength: "EXACT", aspect: "value", admits: "exactly one value" };
  }

  if (EXISTENCE_NULLARY.has(matcher)) {
    // `not.toBeDefined()` is `toBeUndefined()`: it pins one value.
    if (negated && matcher === "toBeDefined") {
      return { strength: "EXACT", aspect: "value", admits: "only undefined" };
    }
    return {
      strength: "EXISTENCE",
      aspect: "value",
      admits:
        matcher === "toBeDefined"
          ? "every value except undefined"
          : matcher === "toBeTruthy"
            ? "every truthy value"
            : "every falsy value",
    };
  }

  // -- Type matchers ---------------------------------------------------------
  if (matcher === "toBeInstanceOf" || matcher === "toBeTypeOf" || matcher === "toBeA" || matcher === "toBeAn") {
    return {
      strength: negated ? "VACUOUS" : "TYPE_ONLY",
      aspect: "value",
      admits: negated ? "any value of a different type" : "any value of this type",
    };
  }

  // -- Relational / pattern matchers ----------------------------------------
  if (
    matcher === "toBeGreaterThan" ||
    matcher === "toBeGreaterThanOrEqual" ||
    matcher === "toBeLessThan" ||
    matcher === "toBeLessThanOrEqual" ||
    matcher === "toBeCloseTo" ||
    matcher === "toMatch" ||
    matcher === "toBeWithin" ||
    matcher === "toSatisfy"
  ) {
    return {
      strength: negated ? "VACUOUS" : "CONSTRAINED",
      aspect: "value",
      admits: negated ? "any value outside the constraint" : "any value satisfying the constraint",
    };
  }

  // -- Structural matchers ---------------------------------------------------
  if (
    matcher === "toMatchObject" ||
    matcher === "toHaveProperty" ||
    matcher === "toContain" ||
    matcher === "toContainEqual" ||
    matcher === "toHaveLength" ||
    matcher === "toHaveKeys" ||
    matcher === "toIncludeSameMembers"
  ) {
    if (negated) {
      // Asserting a key is *absent* is a precise structural claim, and is the
      // correct oracle for "this field must not be serialised". Distinguished
      // from `not.toContain(x)` / `not.toEqual(x)`, which really do admit almost
      // anything. axios's non-enumerable `cause` regression test is the example.
      if (matcher === "toHaveProperty" || matcher === "toHaveKeys") {
        return {
          strength: "STRUCTURAL",
          aspect: "value",
          admits: "only values that lack this property",
        };
      }
      return {
        strength: "VACUOUS",
        aspect: "value",
        admits: "any value not containing the listed part",
      };
    }
    // toHaveProperty('a') without a value only checks presence of a key.
    if (matcher === "toHaveProperty" && args.length < 2) {
      return {
        strength: "EXISTENCE",
        aspect: "value",
        admits: "any value that has this property, with any content",
      };
    }
    return {
      strength: "STRUCTURAL",
      aspect: "value",
      admits: "any value whose listed parts match",
    };
  }

  // -- Deep / strict equality ------------------------------------------------
  if (matcher === "toBe" || matcher === "toEqual" || matcher === "toStrictEqual") {
    if (negated) {
      // `not.toBe(someObject)` is the canonical way to assert "this is a copy,
      // not the same reference", which is a precise and intentional claim.
      // `not.toBe(3)` is the vacuous case, because it admits every other value.
      //
      // immer's copy-semantics tests are full of the former; treating them as
      // vacuous produced three high-severity findings on correct code.
      const arg = args[0];
      const comparesReference =
        matcher === "toBe" && arg !== undefined && !isLiteralArg(arg) && arg.kind !== "none";
      if (comparesReference) {
        return {
          strength: "CONSTRAINED",
          aspect: "value",
          admits: "any value that is not this exact reference",
        };
      }
      return {
        strength: "VACUOUS",
        aspect: "value",
        admits: "every value except the one listed",
      };
    }
    if (looseness === "type") {
      return {
        strength: "TYPE_ONLY",
        aspect: "value",
        admits: "any value whose fields have the right types",
      };
    }
    if (looseness === "partial") {
      return {
        strength: "STRUCTURAL",
        aspect: "value",
        admits: "any value whose listed parts match",
      };
    }
    const first = args[0];
    if (isLiteralArg(first)) {
      return { strength: "EXACT", aspect: "value", admits: "exactly one value" };
    }
    if (first && (first.kind === "object" || first.kind === "array")) {
      return {
        strength: "EXACT",
        aspect: "value",
        admits: "exactly one structure",
      };
    }
    // expect(a).toBe(b) where b is a variable or call: still an exact
    // comparison, but the expected side is computed. Whether that computation
    // is independent of the SUT is the self-derived-oracle rule's problem.
    return {
      strength: "EXACT",
      aspect: "value",
      admits: "exactly one value, computed at run time",
    };
  }

  if (matcher === "toBeTrue" || matcher === "toBeFalse") {
    return {
      strength: negated ? "EXACT" : "EXACT",
      aspect: "value",
      admits: "exactly one value",
    };
  }

  // Assertion-count bookkeeping, not a behavioural check.
  if (matcher === "assertions" || matcher === "hasAssertions") {
    return { strength: "NONE", aspect: "unknown", admits: "nothing about behaviour" };
  }

  return {
    strength: "STRUCTURAL",
    aspect: "unknown",
    admits: "an unrecognised condition",
  };
}

/** Matchers TestSlop treats as observing a collaborator rather than an outcome. */
export function isInteractionMatcher(matcher: string): boolean {
  return INTERACTION_MATCHERS.has(matcher);
}

export function isSnapshotMatcher(matcher: string): boolean {
  return SNAPSHOT_MATCHERS.has(matcher);
}
