/**
 * Rules about tests that execute code without meaningfully verifying it.
 *
 *   weak-new-test    (Hypothesis C) a newly added test whose oracle cannot fail
 *   mock-only-test   the test verifies its own mock wiring, not an outcome
 *   self-derived-oracle  the expected value is computed by the code under test
 *
 * These are the rules with the most overlap risk against existing linters, so
 * each one is deliberately scoped to the part that linters cannot reach:
 * `expect-expect` finds tests with no assertions; these find tests with
 * assertions that do not discriminate. That distinction is the whole point.
 */

import type { AnalysisContext, Finding, Rule, TestCase, TestFileModel } from "../core/types.ts";
import { strengthRank } from "../core/types.ts";
import { isInteractionMatcher } from "../adapters/ts/strength.ts";

/** Tests present in `after` but not in `before`. */
function newCases(before: TestFileModel | undefined, after: TestFileModel): TestCase[] {
  if (!before) return after.cases;
  const known = new Set(before.cases.map((c) => c.fullName));
  return after.cases.filter((c) => !known.has(c.fullName));
}

function isWeakClass(strength: string): boolean {
  return strength === "EXISTENCE" || strength === "OPAQUE" || strength === "VACUOUS" || strength === "NONE";
}

export const weakNewTest: Rule = {
  id: "weak-new-test",
  title: "A newly added test's assertions cannot distinguish correct from incorrect behaviour",
  uniqueness:
    "expect-expect passes this test because assertions exist. Coverage counts the lines as covered. Only a strength model notices that every assertion in the test admits almost any value.",
  defaultSeverity: "medium",
  baseConfidence: 0.78,
  diffAware: false,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      if (!entry.after) continue;
      for (const c of newCases(entry.before, entry.after)) {
        if (c.assertions.length === 0) continue; // covered by expect-expect; skip
        if (c.modifier === "skip" || c.modifier === "todo") continue;

        const weak = c.assertions.filter((a) => isWeakClass(a.strength));
        if (weak.length !== c.assertions.length) continue;

        // A test whose entire purpose is a nullish check is legitimate when the
        // subject is genuinely optional. The signal is much stronger when the
        // test calls into production code and then only checks that something
        // came back.
        const callsProduction = c.calls.some((name) => !/^(expect|vi|jest|sinon|console)\b/.test(name));
        if (!callsProduction) continue;

        const allExistence = c.assertions.every((a) => a.strength === "EXISTENCE");
        const snapshotOnly = c.assertions.every((a) => a.aspect === "snapshot");

        findings.push({
          ruleId: "weak-new-test",
          severity: c.assertions.length >= 2 || snapshotOnly ? "medium" : "medium",
          class: "review",
          confidence: allExistence ? 0.82 : 0.7,
          file: entry.file.path,
          line: c.line,
          testName: c.fullName,
          message: snapshotOnly
            ? `New test verifies behaviour only through a snapshot.`
            : `New test runs production code but every assertion is an existence-level check.`,
          rationale: snapshotOnly
            ? "A snapshot records whatever the code currently does. If the code was wrong when the snapshot was taken, the test locks the bug in."
            : "This test raises coverage and will stay green across almost any change to the code it calls.",
          evidence: [
            {
              label: `Assertions (${c.assertions.length})`,
              after: c.assertions.map((a) => `${a.raw}   -> ${a.strength}`).join("\n"),
            },
            { label: "Production calls", detail: c.calls.slice(0, 6).join(", ") || "none detected" },
          ],
        });
      }
    }

    return findings;
  },
};

export const mockOnlyTest: Rule = {
  id: "mock-only-test",
  title: "A test asserts only on mock interactions, never on an observable outcome",
  uniqueness:
    "Structurally valid and idiomatic; no linter flags it. Needs classifying each assertion as interaction-vs-outcome and knowing which tests are new or changed in this diff.",
  defaultSeverity: "medium",
  baseConfidence: 0.75,
  diffAware: false,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      if (!entry.after) continue;
      const beforeByName = new Map((entry.before?.cases ?? []).map((c) => [c.fullName, c] as const));

      for (const c of entry.after.cases) {
        if (c.assertions.length === 0) continue;
        if (c.modifier === "skip" || c.modifier === "todo") continue;

        const interaction = c.assertions.filter((a) => isInteractionMatcher(a.matcher));
        const outcome = c.assertions.filter((a) => !isInteractionMatcher(a.matcher) && a.aspect !== "snapshot");
        if (interaction.length === 0 || outcome.length > 0) continue;

        const prior = beforeByName.get(c.fullName);
        const isNew = !prior;
        // A pre-existing mock-only test is a design opinion the team already
        // lives with. One that appeared or grew in this diff is what we care
        // about, so unchanged tests are skipped entirely.
        const grew = prior ? interaction.length > prior.assertions.length : false;
        if (!isNew && !grew) continue;

        const mockCount = c.mockOps.length + (entry.after.moduleMocks.length > 0 ? entry.after.moduleMocks.length : 0);

        findings.push({
          ruleId: "mock-only-test",
          severity: interaction.length >= 3 ? "medium" : "low",
          class: "review",
          confidence: isNew ? 0.78 : 0.68,
          file: entry.file.path,
          line: c.line,
          testName: c.fullName,
          message: `${isNew ? "New test" : "Test"} makes ${interaction.length} mock-interaction assertion${interaction.length === 1 ? "" : "s"} and 0 observable-outcome assertions.`,
          rationale:
            "This verifies that the test's own wiring was called. It would still pass if the function returned the wrong value, or nothing at all.",
          evidence: [
            {
              label: "Interaction assertions",
              after: interaction.slice(0, 5).map((a) => a.raw).join("\n"),
            },
            ...(mockCount > 0
              ? [{ label: "Mocks in scope", detail: `${mockCount} mock declaration${mockCount === 1 ? "" : "s"}` }]
              : []),
          ],
        });
      }
    }

    return findings;
  },
};

/**
 * Rule: self-derived-oracle
 *
 * Two detectable shapes:
 *
 *  (a) The same call appears on both sides of the comparison, so the assertion
 *      is a tautology: `expect(slug(x)).toBe(slug(x))`.
 *  (b) The expected side re-implements the production expression. Detected by
 *      comparing the test's expected expression against the return expressions
 *      of the linked production module. Structural token overlap above a
 *      threshold means the test is checking the code against a copy of itself.
 *
 * (b) is the interesting one and the reason production return expressions are
 * extracted at all. It is kept conservative: short expressions and expressions
 * without an operator are ignored, because `return x` overlapping with
 * `expect(f(x)).toBe(x)` is not evidence of anything.
 */
export const selfDerivedOracle: Rule = {
  id: "self-derived-oracle",
  title: "The expected value is produced by the same logic under test",
  uniqueness:
    "Needs the production source and the test source together. A linter sees a normal assertion; mutation testing sees a surviving mutant without being able to say why.",
  defaultSeverity: "high",
  baseConfidence: 0.72,
  diffAware: false,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    const prodByPath = new Map(ctx.production.map((p) => [p.file.path, p] as const));

    for (const entry of ctx.tests) {
      if (!entry.after) continue;
      const knownBefore = new Set((entry.before?.cases ?? []).map((c) => c.fullName));

      for (const c of entry.after.cases) {
        // Only newly added tests. A pre-existing tautology is a known quantity;
        // one introduced by this change is what a reviewer needs to see.
        if (knownBefore.has(c.fullName)) continue;
        for (const a of c.assertions) {
          if (a.aspect !== "value") continue;
          const expected = a.args[0];
          if (!expected) continue;

          // (a) tautology: identical text on both sides
          const normalisedSubject = a.subject.replace(/\s+/g, "");
          const normalisedExpected = expected.raw.replace(/\s+/g, "");
          if (
            !a.negated &&
            normalisedSubject === normalisedExpected &&
            /[(]/.test(normalisedSubject) // only interesting when it is a call
          ) {
            findings.push({
              ruleId: "self-derived-oracle",
              severity: "high",
              class: "review",
              confidence: 0.95,
              file: entry.file.path,
              line: a.line,
              testName: c.fullName,
              message: "Assertion compares an expression to itself, so it cannot fail.",
              rationale: "Whatever the implementation returns will satisfy this assertion.",
              evidence: [{ label: "Assertion", after: a.raw }],
            });
            continue;
          }

          // (b) expected side duplicates a production return expression
          if (expected.kind !== "expression" && expected.kind !== "call" && expected.kind !== "identifier") continue;
          const tokens = tokenise(expected.raw);
          if (tokens.operators.length === 0 || tokens.all.length < 3) continue;

          for (const prodPath of ctx.testToProduction.get(entry.file.path) ?? []) {
            const prod = prodByPath.get(prodPath)?.after;
            if (!prod) continue;
            for (const [fnName, returns] of prod.returnExpressions) {
              // Only compare against functions this test actually calls.
              if (!c.calls.some((call) => call === fnName || call.endsWith(`.${fnName}`))) continue;
              for (const ret of returns) {
                const retTokens = tokenise(ret);
                if (retTokens.operators.length === 0) continue;
                const overlap = similarity(tokens, retTokens);
                if (overlap < 0.7) continue;

                findings.push({
                  ruleId: "self-derived-oracle",
                  severity: "high",
                  class: "review",
                  confidence: overlap >= 0.9 ? 0.85 : 0.7,
                  file: entry.file.path,
                  line: a.line,
                  productionFile: prodPath,
                  testName: c.fullName,
                  message: `Expected value re-implements the body of \`${fnName}\`, so the test checks the code against a copy of itself.`,
                  rationale:
                    "If the formula is wrong, both sides are wrong together and the test still passes. The expectation should be a value the specification fixes, not the same calculation.",
                  evidence: [
                    { label: "Test expectation", after: expected.raw },
                    { label: `Production ${fnName} returns`, after: ret },
                    { label: "Structural overlap", detail: `${Math.round(overlap * 100)}%` },
                  ],
                });
                break;
              }
            }
          }
        }
      }
    }

    const seen = new Set<string>();
    return findings.filter((f) => {
      const key = `${f.file}:${f.line}:${f.ruleId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
};

interface Tokens {
  all: string[];
  operators: string[];
  literals: string[];
  identifiers: string[];
}

/**
 * Splits an expression into comparable pieces. Identifier *names* are
 * intentionally kept: a test that reuses the production variable names is a
 * stronger signal of copy-paste than one that merely shares operators.
 */
export function tokenise(expr: string): Tokens {
  const raw = expr.match(/[A-Za-z_$][\w$]*|\d+\.?\d*|[+\-*/%><=!&|?]+|[().,[\]]/g) ?? [];
  const operators = raw.filter((t) => /^[+\-*/%><=!&|?]+$/.test(t));
  const literals = raw.filter((t) => /^\d/.test(t));
  const identifiers = raw.filter((t) => /^[A-Za-z_$]/.test(t));
  return { all: raw, operators, literals, identifiers };
}

/**
 * Jaccard similarity over the operator and literal skeleton, plus a bonus for
 * shared identifier suffixes. Operators and literals carry the arithmetic
 * meaning; identifiers may legitimately differ between test and production.
 */
export function similarity(a: Tokens, b: Tokens): number {
  const skeleton = (t: Tokens): Set<string> => new Set([...t.operators, ...t.literals]);
  const sa = skeleton(a);
  const sb = skeleton(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = new Set([...sa, ...sb]).size;
  const jaccard = inter / union;

  const ia = new Set(a.identifiers.map((s) => s.toLowerCase()));
  const ib = new Set(b.identifiers.map((s) => s.toLowerCase()));
  let idInter = 0;
  for (const x of ia) if (ib.has(x)) idInter += 1;
  const idScore = ia.size > 0 ? idInter / ia.size : 0;

  return jaccard * 0.7 + idScore * 0.3;
}
