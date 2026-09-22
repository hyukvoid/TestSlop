/**
 * Rule: expected-chasing-implementation  (Hypothesis B)
 *
 * Detects a production constant or operator moving in the same changeset as the
 * test expectation that pins it.
 *
 * This is explicitly a *correlation*, not a defect: updating both sides is
 * exactly what a legitimate requirements change looks like. So the rule's job is
 * not to decide, it is to (a) notice the coupling and (b) quantify how strongly
 * the new expected value looks *derived from* the new implementation rather than
 * from a specification.
 *
 * The derivability check is the part that makes this more than a vague warning.
 * Given production `0.12 -> 0.10` and a test expectation `120 -> 100`, TestSlop
 * checks whether
 *
 *     expectedAfter == expectedBefore * (constAfter / constBefore)
 *
 * holds. When it does, the new expected value is arithmetically consistent with
 * "run the new code and write down what it printed", which is the signature of a
 * lost oracle. That pushes the finding from low to high confidence, and it is
 * reported as the reason in the output so a reviewer can disagree with it.
 */

import type {
  AnalysisContext,
  Assertion,
  ChangedFile,
  EvidenceBlock,
  Finding,
  ProductionSignal,
  Rule,
} from "../core/types.ts";
import { pairAssertions } from "./assertion-weakened.ts";
import type { PairingResult } from "../core/pairing.ts";

interface ConstantChange {
  before: number;
  after: number;
  line: number;
  enclosing?: string;
}

interface OperatorChange {
  before: string;
  after: string;
  line: number;
  enclosing?: string;
}

/**
 * Compares the multiset of numeric literals per enclosing function between the
 * two revisions. Working per-function rather than per-file keeps unrelated
 * constants elsewhere in a large file from producing spurious pairs.
 */
export function numericChanges(beforeSignals: ProductionSignal[], afterSignals: ProductionSignal[]): ConstantChange[] {
  const groupBy = (sigs: ProductionSignal[]): Map<string, ProductionSignal[]> => {
    const m = new Map<string, ProductionSignal[]>();
    for (const s of sigs) {
      if (s.kind !== "numeric-literal") continue;
      const key = s.enclosing ?? "<module>";
      const list = m.get(key) ?? [];
      list.push(s);
      m.set(key, list);
    }
    return m;
  };

  const b = groupBy(beforeSignals);
  const a = groupBy(afterSignals);
  const out: ConstantChange[] = [];

  for (const [fn, afterList] of a) {
    const beforeList = b.get(fn) ?? [];
    const beforeVals = beforeList.map((s) => s.numeric!).filter((n) => Number.isFinite(n));
    const afterVals = afterList.map((s) => s.numeric!).filter((n) => Number.isFinite(n));

    const removed = multisetDifference(beforeVals, afterVals);
    const added = multisetDifference(afterVals, beforeVals);

    // Only treat as a "constant moved" when exactly one value left and one
    // arrived; anything more ambiguous is not worth guessing at.
    if (removed.length === 1 && added.length === 1) {
      const line = afterList.find((s) => s.numeric === added[0])?.line ?? afterList[0]?.line ?? 1;
      out.push({ before: removed[0]!, after: added[0]!, line, enclosing: fn === "<module>" ? undefined : fn });
    }
  }
  return out;
}

function multisetDifference(from: number[], remove: number[]): number[] {
  const pool = [...remove];
  const out: number[] = [];
  for (const v of from) {
    const idx = pool.indexOf(v);
    if (idx >= 0) pool.splice(idx, 1);
    else out.push(v);
  }
  return out;
}

interface StringChange {
  before: string;
  after: string;
  line: number;
  enclosing?: string;
}

/**
 * String constants that moved, per enclosing function.
 *
 * POC-01 expansion. Strings were chosen as the first non-numeric expectation type
 * because they admit the same standard of proof as numbers: if the test's new
 * expected string is *character-for-character* the implementation's new string
 * constant, and the old expected string was the old one, the expectation demonstrably
 * tracks the code rather than a specification. There is nothing to infer.
 *
 * Booleans were considered and rejected: with only two possible values, "production
 * flipped true->false and the test expectation flipped too" is satisfied by
 * coincidence far too often to carry evidence. Recorded in docs/EVIDENCE-LOG.md E05.
 */
export function stringChanges(beforeSignals: ProductionSignal[], afterSignals: ProductionSignal[]): StringChange[] {
  const groupBy = (sigs: ProductionSignal[]): Map<string, ProductionSignal[]> => {
    const m = new Map<string, ProductionSignal[]>();
    for (const s of sigs) {
      if (s.kind !== "string-literal") continue;
      const key = s.enclosing ?? "<module>";
      const list = m.get(key) ?? [];
      list.push(s);
      m.set(key, list);
    }
    return m;
  };

  const b = groupBy(beforeSignals);
  const a = groupBy(afterSignals);
  const out: StringChange[] = [];

  for (const [fn, afterList] of a) {
    const beforeVals = (b.get(fn) ?? []).map((s) => s.text);
    const afterVals = afterList.map((s) => s.text);
    const removed = multisetDifferenceOf(beforeVals, afterVals);
    const added = multisetDifferenceOf(afterVals, beforeVals);
    if (removed.length === 1 && added.length === 1) {
      const line = afterList.find((s) => s.text === added[0])?.line ?? afterList[0]?.line ?? 1;
      out.push({ before: removed[0]!, after: added[0]!, line, enclosing: fn === "<module>" ? undefined : fn });
    }
  }
  return out;
}

function multisetDifferenceOf<T>(from: T[], remove: T[]): T[] {
  const pool = [...remove];
  const out: T[] = [];
  for (const v of from) {
    const idx = pool.indexOf(v);
    if (idx >= 0) pool.splice(idx, 1);
    else out.push(v);
  }
  return out;
}

export function operatorChanges(beforeSignals: ProductionSignal[], afterSignals: ProductionSignal[]): OperatorChange[] {
  const pick = (sigs: ProductionSignal[]): string[] =>
    sigs.filter((s) => s.kind === "comparison-operator" || s.kind === "logical-operator").map((s) => s.text);
  const b = pick(beforeSignals);
  const a = pick(afterSignals);
  const removed = b.filter((x) => !a.includes(x));
  const added = a.filter((x) => !b.includes(x));
  if (removed.length === 1 && added.length === 1) {
    const sig = afterSignals.find((s) => s.text === added[0]);
    return [{ before: removed[0]!, after: added[0]!, line: sig?.line ?? 1, enclosing: sig?.enclosing }];
  }
  return [];
}

/** An expectation that changed inside a test, keyed to its assertion. */
interface ExpectationChange {
  kind: "numeric" | "string";
  before: number | string;
  after: number | string;
  assertionBefore: Assertion;
  assertionAfter: Assertion;
  line: number;
  testName: string;
}

/**
 * Checks whether `after` is what you get by taking `before` and applying the
 * same proportional or additive change the production constant underwent. Tries
 * the two transformations that cover almost all real cases (scaling a rate,
 * shifting an offset) and reports which one matched.
 */
export function derivationOf(
  expectedBefore: number,
  expectedAfter: number,
  constBefore: number,
  constAfter: number,
): string | undefined {
  const close = (x: number, y: number): boolean => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const scale = Math.max(1, Math.abs(x), Math.abs(y));
    return Math.abs(x - y) <= 1e-9 * scale;
  };

  if (constBefore !== 0) {
    const scaled = expectedBefore * (constAfter / constBefore);
    if (close(scaled, expectedAfter)) {
      return `expected value scaled by exactly the same ratio as the implementation constant (${constAfter}/${constBefore})`;
    }
  }
  const shifted = expectedBefore + (constAfter - constBefore);
  if (close(shifted, expectedAfter)) {
    return `expected value shifted by exactly the same delta as the implementation constant (${constAfter - constBefore >= 0 ? "+" : ""}${constAfter - constBefore})`;
  }
  // The test simply adopted the new constant verbatim.
  if (close(expectedAfter, constAfter) && !close(expectedBefore, constAfter)) {
    return "expected value is now the implementation constant itself";
  }
  return undefined;
}

/**
 * Proof, not inference, for string expectations.
 *
 * Two strengths of evidence, and nothing weaker is accepted:
 *
 *   both sides tracked   the expectation was the old constant and is now the new one
 *   adopted              the expectation is now exactly the new constant
 *
 * If the new expected string merely differs from the old one, that is a normal
 * consequence of changing a message and carries no information. Returning undefined
 * in that case is what stops this expansion from degenerating into "a test and its
 * code changed in the same commit".
 */
export function stringDerivationOf(
  expectedBefore: string,
  expectedAfter: string,
  constBefore: string,
  constAfter: string,
): string | undefined {
  if (expectedBefore === constBefore && expectedAfter === constAfter) {
    return `expected string tracked the implementation constant exactly, before ("${constBefore}") and after ("${constAfter}")`;
  }
  if (expectedAfter === constAfter && expectedBefore !== constAfter) {
    return `expected string is now character-for-character the implementation's new constant ("${constAfter}")`;
  }
  // A substring relationship is weaker but still checkable by a reviewer, e.g. the
  // test asserts on a message that embeds the changed constant.
  if (
    constAfter.length >= 6 &&
    expectedAfter.includes(constAfter) &&
    !expectedBefore.includes(constAfter) &&
    expectedBefore.includes(constBefore)
  ) {
    return `expected string embeds the implementation's new constant ("${constAfter}"), and previously embedded the old one`;
  }
  return undefined;
}

function expectationChanges(pairing: PairingResult): ExpectationChange[] {
  const out: ExpectationChange[] = [];

  for (const casePair of pairing.pairs) {
    const bc = casePair.before;
    const ac = casePair.after;
    for (const pair of pairAssertions(bc.assertions, ac.assertions)) {
      const bArg = pair.before.args[0];
      const aArg = pair.after.args[0];
      if (!bArg || !aArg) continue;

      const common = {
        assertionBefore: pair.before,
        assertionAfter: pair.after,
        line: pair.after.line,
        testName: ac.fullName,
      };

      if (bArg.numeric !== undefined && aArg.numeric !== undefined) {
        if (bArg.numeric === aArg.numeric) continue;
        out.push({ kind: "numeric", before: bArg.numeric, after: aArg.numeric, ...common });
        continue;
      }

      if (bArg.string !== undefined && aArg.string !== undefined) {
        if (bArg.string === aArg.string) continue;
        out.push({ kind: "string", before: bArg.string, after: aArg.string, ...common });
      }
    }
  }
  return out;
}

export const expectedChasingImplementation: Rule = {
  id: "expected-chasing-implementation",
  title: "A test expectation moved together with the implementation constant it pins",
  uniqueness:
    "Requires reading a production diff and a test diff together and doing arithmetic across them. No linter sees two files at two revisions, and mutation testing cannot see it at all because the suite is green before and after.",
  defaultSeverity: "high",
  baseConfidence: 0.7,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    const prodByPath = new Map(ctx.production.map((p) => [p.file.path, p] as const));

    for (const testEntry of ctx.tests) {
      if (!testEntry.before || !testEntry.after) continue;
      const pairing = ctx.pairings.get(testEntry.file.path);
      if (!pairing) continue;
      const changes = expectationChanges(pairing);
      if (changes.length === 0) continue;

      const linkedPaths = ctx.testToProduction.get(testEntry.file.path) ?? [];
      for (const prodPath of linkedPaths) {
        const prod = prodByPath.get(prodPath);
        if (!prod?.before || !prod.after) continue;

        const consts = numericChanges(prod.before.signals, prod.after.signals);
        const strings = stringChanges(prod.before.signals, prod.after.signals);
        const ops = operatorChanges(prod.before.signals, prod.after.signals);
        if (consts.length === 0 && strings.length === 0 && ops.length === 0) continue;

        for (const change of changes) {
          let derivation: string | undefined;
          let matchedConst: ConstantChange | undefined;
          let matchedString: StringChange | undefined;

          if (change.kind === "numeric") {
            // Look for an implementation constant change that explains this
            // expectation change arithmetically.
            for (const c of consts) {
              const d = derivationOf(change.before as number, change.after as number, c.before, c.after);
              if (d) {
                derivation = d;
                matchedConst = c;
                break;
              }
            }
          } else {
            // Strings admit only exact proof, never inference.
            for (const s of strings) {
              const d = stringDerivationOf(change.before as string, change.after as string, s.before, s.after);
              if (d) {
                derivation = d;
                matchedString = s;
                break;
              }
            }
            // A string expectation with no exact match to a moved production string
            // is not evidence of anything, so it is dropped rather than reported at
            // low confidence. This is what keeps the expansion from becoming
            // "the test and the code changed together".
            if (!derivation) continue;
          }

          const anchor = matchedConst ?? consts[0];
          const site = matchedString ?? anchor;
          const evidence: EvidenceBlock[] = [
            {
              label: `Production (${prodPath})`,
              before: site ? `${site.enclosing ? site.enclosing + ": " : ""}${JSON.stringify(site.before)}` : ops[0]?.before,
              after: site ? `${site.enclosing ? site.enclosing + ": " : ""}${JSON.stringify(site.after)}` : ops[0]?.after,
            },
            {
              label: "Test expectation",
              before: change.assertionBefore.raw,
              after: change.assertionAfter.raw,
            },
          ];
          if (derivation) {
            evidence.push({ label: "Derivation", detail: derivation });
          }

          const severity = derivation ? "high" : "medium";
          const confidence = derivation ? 0.9 : 0.6;

          findings.push({
            ruleId: "expected-chasing-implementation",
            severity,
            class: "review",
            confidence,
            file: testEntry.file.path,
            line: change.line,
            productionFile: prodPath,
            productionLine: (matchedString ?? anchor)?.line ?? ops[0]?.line,
            testName: change.testName,
            message: derivation
              ? change.kind === "string"
                ? `Expected string changed ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)} and is exactly the implementation''s new constant.`
                : `Expected value changed ${change.before} -> ${change.after} in lockstep with the implementation, and is arithmetically derivable from it.`
              : `Expected value changed ${change.before} -> ${change.after} in the same changeset that changed the implementation it pins.`,
            rationale: derivation
              ? "When the new expectation can be computed from the new code, the test no longer provides an independent check of the requirement. Confirm the number came from the specification, not from running the code."
              : "This is the normal shape of a legitimate requirements change, and also the normal shape of a test being retrofitted to match new behaviour. Only the author knows which.",
            evidence,
          });
        }
      }
    }

    // Deduplicate: the same test expectation can link to several production files.
    const seen = new Set<string>();
    return findings.filter((f) => {
      const key = `${f.file}:${f.line}:${f.productionFile}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
};
