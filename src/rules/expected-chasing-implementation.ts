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

/** Numeric expectations that changed inside a test, keyed to their assertion. */
interface ExpectationChange {
  before: number;
  after: number;
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

function expectationChanges(
  beforeCases: readonly { fullName: string; assertions: Assertion[] }[],
  afterCases: readonly { fullName: string; assertions: Assertion[] }[],
): ExpectationChange[] {
  const afterByName = new Map(afterCases.map((c) => [c.fullName, c] as const));
  const out: ExpectationChange[] = [];

  for (const bc of beforeCases) {
    const ac = afterByName.get(bc.fullName);
    if (!ac) continue;
    for (const pair of pairAssertions(bc.assertions, ac.assertions)) {
      const bArg = pair.before.args[0];
      const aArg = pair.after.args[0];
      if (bArg?.numeric === undefined || aArg?.numeric === undefined) continue;
      if (bArg.numeric === aArg.numeric) continue;
      out.push({
        before: bArg.numeric,
        after: aArg.numeric,
        assertionBefore: pair.before,
        assertionAfter: pair.after,
        line: pair.after.line,
        testName: ac.fullName,
      });
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
      const changes = expectationChanges(testEntry.before.cases, testEntry.after.cases);
      if (changes.length === 0) continue;

      const linkedPaths = ctx.testToProduction.get(testEntry.file.path) ?? [];
      for (const prodPath of linkedPaths) {
        const prod = prodByPath.get(prodPath);
        if (!prod?.before || !prod.after) continue;

        const consts = numericChanges(prod.before.signals, prod.after.signals);
        const ops = operatorChanges(prod.before.signals, prod.after.signals);
        if (consts.length === 0 && ops.length === 0) continue;

        for (const change of changes) {
          // Look for an implementation constant change that explains this
          // expectation change arithmetically.
          let derivation: string | undefined;
          let matchedConst: ConstantChange | undefined;
          for (const c of consts) {
            const d = derivationOf(change.before, change.after, c.before, c.after);
            if (d) {
              derivation = d;
              matchedConst = c;
              break;
            }
          }

          const anchor = matchedConst ?? consts[0];
          const evidence: EvidenceBlock[] = [
            {
              label: `Production (${prodPath})`,
              before: anchor ? `${anchor.enclosing ? anchor.enclosing + ": " : ""}${anchor.before}` : ops[0]?.before,
              after: anchor ? `${anchor.enclosing ? anchor.enclosing + ": " : ""}${anchor.after}` : ops[0]?.after,
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
            productionLine: anchor?.line ?? ops[0]?.line,
            testName: change.testName,
            message: derivation
              ? `Expected value changed ${change.before} -> ${change.after} in lockstep with the implementation, and is arithmetically derivable from it.`
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
