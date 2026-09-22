/**
 * Rule: assertion-weakened  (Hypothesis A)
 *
 * The flagship detector. For every test case that exists in both revisions,
 * pair up assertions by the expression being observed and report pairs where
 * the matcher started accepting strictly more behaviour.
 *
 * Why this cannot be a lint rule: both the before and the after state are
 * individually valid, idiomatic code. `expect(res.status).toBeDefined()` is
 * something eslint-plugin-jest is perfectly happy with. The defect exists only
 * in the transition, so the analysis needs two revisions of the same test.
 *
 * Pairing strategy, in order:
 *   1. identical normalised subject expression  (highest confidence)
 *   2. same assertion index within the test when subjects differ only in the
 *      expected value, and the subject shares a root identifier
 *
 * Step 2 exists because agents often rename a local while weakening a matcher.
 * It is confidence-penalised rather than trusted equally.
 */

import type { Assertion, AnalysisContext, Finding, Rule, TestCase } from "../core/types.ts";
import { strengthRank } from "../core/types.ts";
import { basisConfidenceFactor } from "../core/pairing.ts";
import { classifyMatcher } from "../adapters/ts/strength.ts";

function rootIdentifier(a: Assertion): string | undefined {
  return a.subjectIdentifiers[0];
}

interface Pair {
  before: Assertion;
  after: Assertion;
  /** How the pair was established. Drives confidence. */
  basis: "same-subject" | "positional";
}

export function pairAssertions(before: Assertion[], after: Assertion[]): Pair[] {
  const pairs: Pair[] = [];
  const usedAfter = new Set<number>();
  const usedBefore = new Set<number>();

  // (1) Exact subject match. Handle duplicates by consuming in order.
  before.forEach((b, bi) => {
    const ai = after.findIndex((a, idx) => !usedAfter.has(idx) && a.subjectKey === b.subjectKey);
    if (ai >= 0) {
      pairs.push({ before: b, after: after[ai]!, basis: "same-subject" });
      usedAfter.add(ai);
      usedBefore.add(bi);
    }
  });

  // (2) Positional match for leftovers sharing a root identifier.
  const leftoverBefore = before.map((b, i) => ({ b, i })).filter(({ i }) => !usedBefore.has(i));
  const leftoverAfter = after.map((a, i) => ({ a, i })).filter(({ i }) => !usedAfter.has(i));
  const n = Math.min(leftoverBefore.length, leftoverAfter.length);
  for (let k = 0; k < n; k += 1) {
    const b = leftoverBefore[k]!.b;
    const a = leftoverAfter[k]!.a;
    const rb = rootIdentifier(b);
    const ra = rootIdentifier(a);
    if (rb && ra && rb === ra) {
      pairs.push({ before: b, after: a, basis: "positional" });
      usedAfter.add(leftoverAfter[k]!.i);
    }
  }

  return pairs;
}

function describeTransition(before: Assertion, after: Assertion): string {
  const b = classifyMatcher(before.matcher, before.args, before.negated);
  const a = classifyMatcher(after.matcher, after.args, after.negated);
  return `Previously accepted ${b.admits}. Now accepts ${a.admits}.`;
}

/**
 * Some downgrades are legitimate and common enough that flagging them at high
 * severity would burn trust. A drop from EXACT to STRUCTURAL is often a genuine
 * robustness improvement (pinning a whole object is brittle). Drops that land on
 * EXISTENCE / OPAQUE / VACUOUS are the dangerous ones, because the assertion
 * loses the ability to distinguish correct from incorrect values.
 */
function severityFor(beforeRank: number, afterRank: number, afterClass: string): { severity: "high" | "medium" | "low"; confidence: number } | undefined {
  const delta = beforeRank - afterRank;
  if (delta <= 0) return undefined;

  const collapsed = afterClass === "EXISTENCE" || afterClass === "OPAQUE" || afterClass === "VACUOUS" || afterClass === "NONE";

  if (collapsed && delta >= 3) return { severity: "high", confidence: 0.93 };
  if (collapsed) return { severity: "high", confidence: 0.85 };
  if (delta >= 3) return { severity: "medium", confidence: 0.72 };
  // e.g. EXACT -> STRUCTURAL. Report, but quietly.
  return { severity: "low", confidence: 0.55 };
}

export const assertionWeakened: Rule = {
  id: "assertion-weakened",
  title: "An assertion now accepts more behaviour than it did before",
  uniqueness:
    "Both revisions are individually valid code that no linter objects to. Only the transition is suspicious, so two revisions of the same test are required.",
  defaultSeverity: "high",
  baseConfidence: 0.88,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      const { before, after } = entry;
      if (!before || !after) continue;

      const pairing = ctx.pairings.get(entry.file.path);
      if (!pairing) continue;

      for (const casePair of pairing.pairs) {
        const beforeCase = casePair.before;
        const afterCase = casePair.after;

        for (const pair of pairAssertions(beforeCase.assertions, afterCase.assertions)) {
          const beforeRank = strengthRank(pair.before.strength);
          const afterRank = strengthRank(pair.after.strength);
          const verdict = severityFor(beforeRank, afterRank, pair.after.strength);
          if (!verdict) continue;

          // A changed aspect (value assertion replaced by an interaction
          // assertion) is reported by mock-only-test instead; avoid double
          // reporting the same line with two stories.
          if (pair.before.aspect === "value" && pair.after.aspect === "interaction") continue;

          // Confidence is discounted for both kinds of uncertainty: how the test
          // case was matched across revisions, and how the assertion was matched
          // within the case.
          let confidence = verdict.confidence * basisConfidenceFactor(casePair.basis);
          if (pair.basis === "positional") confidence -= 0.18;

          const caveats: string[] = [];
          if (pair.basis === "positional") caveats.push("assertion paired by position; subject expression also changed");
          if (casePair.basis !== "exact-title") {
            caveats.push(
              casePair.basis === "identical-body"
                ? `test renamed from "${beforeCase.name}"; body unchanged`
                : casePair.basis === "leaf-title"
                  ? "test moved to a different describe block"
                  : `test matched to "${beforeCase.name}" by structure (${Math.round(casePair.score * 100)}% similar)`,
            );
          }

          findings.push({
            ruleId: "assertion-weakened",
            severity: verdict.severity,
            class: "review",
            confidence: Number(confidence.toFixed(2)),
            file: entry.file.path,
            line: pair.after.line,
            testName: afterCase.fullName,
            message: `Assertion on \`${pair.after.subject}\` weakened from ${pair.before.strength} to ${pair.after.strength}.`,
            rationale: describeTransition(pair.before, pair.after),
            evidence: [
              {
                label: "Assertion",
                before: pair.before.raw,
                after: pair.after.raw,
                ...(caveats.length > 0 ? { detail: caveats.join("; ") } : {}),
              },
            ],
          });
        }
      }
    }

    return findings;
  },
};

/**
 * Rule: assertion-removed
 *
 * A test survives with its name intact but has fewer assertions than before, or
 * none at all. `expect-expect` catches the zero-assertion end state; it cannot
 * tell you the test used to have four assertions and now has one.
 */
export const assertionRemoved: Rule = {
  id: "assertion-removed",
  title: "A surviving test lost assertions",
  uniqueness:
    "expect-expect only reports tests with zero assertions. It cannot see that a test dropped from four assertions to one while keeping its name.",
  defaultSeverity: "high",
  baseConfidence: 0.8,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      const { before, after } = entry;
      if (!before || !after) continue;
      const pairing = ctx.pairings.get(entry.file.path);
      if (!pairing) continue;

      for (const casePair of pairing.pairs) {
        const beforeCase = casePair.before;
        const afterCase = casePair.after;

        const b = beforeCase.assertions.length;
        const a = afterCase.assertions.length;
        if (a >= b || b === 0) continue;

        // A test rewritten to assert through a throwing query has not lost its
        // oracle, it changed its form. Two real zustand commits forced this:
        //   - `expect(selector).toHaveBeenCalled()` became an ErrorBoundary plus
        //     `getByText('errored')`
        //   - two `expect(count).toBe(n)` calls inside a render callback became
        //     `await waitForElement(() => getByText('count: 0'))`
        // Both are better tests than what they replaced. Counting implicit
        // assertions against lost `expect` calls one-for-one was the wrong
        // comparison, because one query can replace several assertions.
        if (a === 0 && afterCase.implicitAssertions.length > 0) continue;
        if (afterCase.implicitAssertions.length > beforeCase.implicitAssertions.length) continue;

        const paired = new Set(
          pairAssertions(beforeCase.assertions, afterCase.assertions).map((p) => p.before.raw),
        );
        const dropped = beforeCase.assertions.filter((x) => !paired.has(x.raw));
        if (dropped.length === 0) continue;

        // Losing every assertion is categorically worse than losing one of five.
        const severity = a === 0 ? "high" : dropped.length >= 2 ? "medium" : "low";
        const confidence = (a === 0 ? 0.9 : 0.75) * basisConfidenceFactor(casePair.basis);

        findings.push({
          ruleId: "assertion-removed",
          severity,
          class: "review",
          confidence: Number(confidence.toFixed(2)),
          file: entry.file.path,
          line: afterCase.line,
          testName: afterCase.fullName,
          message:
            a === 0
              ? `Test still runs but no longer asserts anything (was ${b} assertion${b === 1 ? "" : "s"}).`
              : `Test dropped from ${b} to ${a} assertions.`,
          rationale:
            "The test keeps its name and its coverage contribution, so neither the test report nor the coverage report changes.",
          evidence: [
            {
              label: `Removed assertion${dropped.length === 1 ? "" : "s"}`,
              before: dropped.slice(0, 4).map((d) => d.raw).join("\n"),
            },
          ],
        });
      }
    }

    return findings;
  },
};
