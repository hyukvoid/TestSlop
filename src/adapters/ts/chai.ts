/**
 * chai support.
 *
 * Selected over ava on measured evidence: chai accounts for 39.4% of the test files
 * with assertions across 22 surveyed repositories, versus 1.6% for ava. Supporting
 * it moves TestSlop's file coverage from 47.7% to 87.0%. See docs/EVIDENCE-LOG.md E04.
 *
 * The design constraint from the brief is that a new ecosystem must "integrate into
 * the existing normalized assertion model rather than introducing framework-specific
 * rules". So this module does exactly one thing: translate a chai chain into the
 * canonical matcher vocabulary the Jest/Vitest classifier already understands, and
 * hand it to `classifyMatcher`. There is a single strength lattice, and no rule
 * anywhere knows that chai exists.
 *
 * Two syntactic forms are handled:
 *
 *   expect(x).to.equal(1)        BDD expect form
 *   x.should.equal(1)            should form
 *
 * and two chain terminations:
 *
 *   ...equal(1)                  a call
 *   ...to.be.true                a bare property whose getter asserts
 *
 * The second is why chai cannot reuse the Jest extraction path: there is no call
 * expression to match on.
 */

import ts from "typescript";
import type { AssertionArg } from "../../core/types.ts";

/** Chain words that carry no assertion meaning on their own. */
const CONNECTORS = new Set([
  "to", "be", "been", "is", "that", "which", "and", "has", "have", "with",
  "at", "of", "same", "but", "does", "still", "also", "the", "an_", "always",
]);

/** Flags that modify how the terminal assertion is interpreted. */
const FLAGS = new Set(["not", "deep", "nested", "own", "any", "all", "ordered", "itself", "flatten"]);

/** Chain terminals that assert by property access, with no call. */
const TERMINAL_PROPERTIES = new Set([
  "true", "false", "null", "undefined", "NaN", "exist", "ok", "empty",
  "finite", "sealed", "frozen", "extensible", "arguments",
  // sinon-chai
  "called", "calledOnce", "calledTwice", "calledThrice", "calledWithNew",
  // chai-as-promised
  "fulfilled", "rejected",
]);

/** Chain terminals that assert by being called. */
const TERMINAL_METHODS = new Set([
  "equal", "equals", "eq", "strictEqual", "eql", "eqls", "deepEqual",
  "above", "gt", "greaterThan", "least", "gte", "below", "lt", "lessThan",
  "most", "lte", "within", "closeTo", "approximately",
  "match", "matches", "a", "an", "instanceof", "instanceOf",
  "include", "includes", "contain", "contains", "property", "lengthOf",
  "length", "keys", "key", "members", "oneOf", "string",
  "throw", "throws", "Throw", "satisfy", "satisfies", "respondTo",
  // sinon-chai
  "calledWith", "calledWithExactly", "calledOnceWith", "calledOnceWithExactly",
  "calledTimes", "returned",
]);

export interface ChaiChain {
  /** Source text of the expression passed to expect(), or the `should` receiver. */
  subjectNode: ts.Expression;
  terminal: string;
  negated: boolean;
  deep: boolean;
  args: ts.Expression[];
  /** Node to report the location of. */
  reportNode: ts.Node;
  form: "expect" | "should";
}

/**
 * Canonical matcher name plus synthetic arguments, ready for `classifyMatcher`.
 *
 * Synthetic arguments matter: chai's `.to.be.true` carries its expected value in the
 * property name, so it has to be materialised as an argument for the lattice to see
 * that the assertion pins exactly one value.
 */
export interface CanonicalMatcher {
  matcher: string;
  negated: boolean;
  syntheticArgs: AssertionArg[];
}

export function toCanonicalMatcher(
  terminal: string,
  flags: { negated: boolean; deep: boolean },
  args: AssertionArg[],
): CanonicalMatcher | undefined {
  const lit = (raw: string, kind: AssertionArg["kind"]): AssertionArg[] => [{ raw, kind }];
  const n = flags.negated;

  switch (terminal) {
    // -- value equality ----------------------------------------------------
    case "equal":
    case "equals":
    case "eq":
    case "strictEqual":
      return { matcher: flags.deep ? "toEqual" : "toBe", negated: n, syntheticArgs: args };
    case "eql":
    case "eqls":
    case "deepEqual":
      return { matcher: "toEqual", negated: n, syntheticArgs: args };

    // -- terminal properties that pin one value ----------------------------
    case "true":
      return { matcher: "toBe", negated: n, syntheticArgs: lit("true", "boolean") };
    case "false":
      return { matcher: "toBe", negated: n, syntheticArgs: lit("false", "boolean") };
    case "null":
      return { matcher: "toBeNull", negated: n, syntheticArgs: [] };
    case "undefined":
      return { matcher: "toBeUndefined", negated: n, syntheticArgs: [] };
    case "NaN":
      return { matcher: "toBeNaN", negated: n, syntheticArgs: [] };

    // -- existence / truthiness --------------------------------------------
    // chai's `.exist` is "not null and not undefined", i.e. an existence check.
    case "exist":
      return { matcher: "toBeDefined", negated: n, syntheticArgs: [] };
    case "ok":
      return { matcher: "toBeTruthy", negated: n, syntheticArgs: [] };

    // -- structure ---------------------------------------------------------
    case "empty":
      return { matcher: "toHaveLength", negated: n, syntheticArgs: lit("0", "number") };
    case "include":
    case "includes":
    case "contain":
    case "contains":
    case "oneOf":
      return { matcher: "toContain", negated: n, syntheticArgs: args };
    case "property":
      return { matcher: "toHaveProperty", negated: n, syntheticArgs: args };
    case "lengthOf":
    case "length":
      return { matcher: "toHaveLength", negated: n, syntheticArgs: args };
    case "keys":
    case "key":
      return { matcher: "toHaveKeys", negated: n, syntheticArgs: args };
    case "members":
      return { matcher: "toIncludeSameMembers", negated: n, syntheticArgs: args };

    // -- ranges and patterns -----------------------------------------------
    case "above":
    case "gt":
    case "greaterThan":
      return { matcher: "toBeGreaterThan", negated: n, syntheticArgs: args };
    case "least":
    case "gte":
      return { matcher: "toBeGreaterThanOrEqual", negated: n, syntheticArgs: args };
    case "below":
    case "lt":
    case "lessThan":
      return { matcher: "toBeLessThan", negated: n, syntheticArgs: args };
    case "most":
    case "lte":
      return { matcher: "toBeLessThanOrEqual", negated: n, syntheticArgs: args };
    case "within":
      return { matcher: "toBeWithin", negated: n, syntheticArgs: args };
    case "closeTo":
    case "approximately":
      return { matcher: "toBeCloseTo", negated: n, syntheticArgs: args };
    case "match":
    case "matches":
    case "string":
      return { matcher: "toMatch", negated: n, syntheticArgs: args };
    case "satisfy":
    case "satisfies":
      return { matcher: "toSatisfy", negated: n, syntheticArgs: args };
    case "finite":
      return { matcher: "toSatisfy", negated: n, syntheticArgs: [] };

    // -- types -------------------------------------------------------------
    case "a":
    case "an":
      // `.to.be.a('string')` is a typeof check; `.to.be.an(SomeClass)` is instanceof.
      return {
        matcher: args[0]?.kind === "string" ? "toBeTypeOf" : "toBeInstanceOf",
        negated: n,
        syntheticArgs: args,
      };
    case "instanceof":
    case "instanceOf":
      return { matcher: "toBeInstanceOf", negated: n, syntheticArgs: args };
    case "respondTo":
      return { matcher: "toHaveProperty", negated: n, syntheticArgs: args };

    // -- errors ------------------------------------------------------------
    case "throw":
    case "throws":
    case "Throw":
      return { matcher: "toThrow", negated: n, syntheticArgs: args };
    case "rejected":
      return { matcher: "toThrow", negated: n, syntheticArgs: [] };
    case "fulfilled":
      return { matcher: "toThrow", negated: !n, syntheticArgs: [] };

    // -- sinon-chai interactions -------------------------------------------
    case "called":
      return { matcher: "toHaveBeenCalled", negated: n, syntheticArgs: [] };
    case "calledOnce":
      return { matcher: "toHaveBeenCalledTimes", negated: n, syntheticArgs: lit("1", "number") };
    case "calledTwice":
      return { matcher: "toHaveBeenCalledTimes", negated: n, syntheticArgs: lit("2", "number") };
    case "calledThrice":
      return { matcher: "toHaveBeenCalledTimes", negated: n, syntheticArgs: lit("3", "number") };
    case "calledTimes":
      return { matcher: "toHaveBeenCalledTimes", negated: n, syntheticArgs: args };
    case "calledWith":
    case "calledOnceWith":
      return { matcher: "toHaveBeenCalledWith", negated: n, syntheticArgs: args };
    case "calledWithExactly":
    case "calledOnceWithExactly":
      return { matcher: "toHaveBeenCalledWith", negated: n, syntheticArgs: args };
    case "returned":
      return { matcher: "toHaveReturned", negated: n, syntheticArgs: args };
    case "calledWithNew":
      return { matcher: "toHaveBeenCalled", negated: n, syntheticArgs: [] };

    // -- object shape ------------------------------------------------------
    case "sealed":
    case "frozen":
    case "extensible":
      return { matcher: "toSatisfy", negated: n, syntheticArgs: [] };
    case "arguments":
      return { matcher: "toBeInstanceOf", negated: n, syntheticArgs: [] };

    default:
      return undefined;
  }
}

interface WalkedChain {
  root: ts.Expression | undefined;
  flags: { negated: boolean; deep: boolean };
  form: "expect" | "should" | undefined;
}

/**
 * Walks a property-access chain inwards from a terminal, collecting flags and
 * looking for either `expect(...)` or `.should`.
 */
function walkChain(node: ts.Expression): WalkedChain {
  let cursor: ts.Expression = node;
  let negated = false;
  let deep = false;
  let form: "expect" | "should" | undefined;
  let root: ts.Expression | undefined;

  while (ts.isPropertyAccessExpression(cursor)) {
    const name = cursor.name.text;
    if (name === "not") negated = !negated;
    else if (name === "deep" || name === "nested" || name === "own") deep = true;
    else if (name === "should") {
      form = "should";
      root = cursor.expression;
      return { root, flags: { negated, deep }, form };
    } else if (!CONNECTORS.has(name) && !FLAGS.has(name)) {
      // An unexpected word: could be a plugin. Keep walking; it does not change
      // the strength semantics of the terminal we already identified.
    }
    cursor = cursor.expression;
  }

  if (
    ts.isCallExpression(cursor) &&
    ts.isIdentifier(cursor.expression) &&
    cursor.expression.text === "expect" &&
    cursor.arguments.length > 0
  ) {
    form = "expect";
    root = cursor.arguments[0];
  }

  return { root, flags: { negated, deep }, form };
}

/**
 * Extracts chai assertions from a test body.
 *
 * Call-terminated and property-terminated chains are found separately, because only
 * the former is a CallExpression. Property-terminated chains are located as
 * expression statements, which is how chai's getter assertions are always written.
 */
export function findChaiChains(sf: ts.SourceFile, body: ts.Node): ChaiChain[] {
  const out: ChaiChain[] = [];
  const seen = new Set<number>();

  const visit = (node: ts.Node): void => {
    // Call-terminated: expect(x).to.equal(1) / x.should.equal(1)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const terminal = node.expression.name.text;
      if (TERMINAL_METHODS.has(terminal)) {
        const walked = walkChain(node.expression.expression);
        if (walked.root && walked.form) {
          seen.add(node.getStart(sf));
          out.push({
            subjectNode: walked.root,
            terminal,
            negated: walked.flags.negated,
            deep: walked.flags.deep,
            args: [...node.arguments],
            reportNode: node,
            form: walked.form,
          });
        }
      }
    }

    // Property-terminated: expect(x).to.be.true
    if (ts.isExpressionStatement(node) && ts.isPropertyAccessExpression(node.expression)) {
      const terminal = node.expression.name.text;
      if (TERMINAL_PROPERTIES.has(terminal)) {
        const walked = walkChain(node.expression.expression);
        if (walked.root && walked.form) {
          out.push({
            subjectNode: walked.root,
            terminal,
            negated: walked.flags.negated,
            deep: walked.flags.deep,
            args: [],
            reportNode: node,
            form: walked.form,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return out;
}

/** True when the file imports chai or a chai plugin. */
export function usesChai(imports: Array<{ specifier: string }>): boolean {
  return imports.some((i) => /^chai($|\/|-)|^sinon-chai$|^chai-as-promised$/.test(i.specifier));
}
