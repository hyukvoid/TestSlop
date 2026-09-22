/**
 * Diff-aware degradation rules.
 *
 * Each of these is defined entirely by a transition between two revisions. None
 * of them can be expressed as a property of a single snapshot of the code, which
 * is what separates them from lint rules with similar-sounding names
 * (`no-disabled-tests` flags every skipped test forever; `test-disabled-to-green`
 * flags the one that was skipped *in this change*, next to the production edit
 * that presumably broke it).
 */

import type {
  AnalysisContext,
  Assertion,
  ChangedFile,
  Finding,
  ProductionFileModel,
  Rule,
  TestCase,
} from "../core/types.ts";
import { isSnapshotMatcher } from "../adapters/ts/strength.ts";

function productionAlsoChanged(ctx: AnalysisContext, testPath: string): string[] {
  return (ctx.testToProduction.get(testPath) ?? []).filter((p) =>
    ctx.production.some((x) => x.file.path === p && x.file.status === "modified"),
  );
}

export const testDisabled: Rule = {
  id: "test-disabled",
  title: "A previously running test was skipped, marked todo, or deleted in this change",
  uniqueness:
    "no-disabled-tests reports every skipped test in the repository with equal weight, forever. This reports only the transition, and pairs it with the production change that accompanied it.",
  defaultSeverity: "high",
  baseConfidence: 0.95,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      const { before, after } = entry;
      if (!before) continue;
      const linkedProd = productionAlsoChanged(ctx, entry.file.path);
      const afterByName = new Map((after?.cases ?? []).map((c) => [c.fullName, c] as const));

      for (const bc of before.cases) {
        if (bc.modifier === "skip" || bc.modifier === "todo") continue; // already disabled
        const ac = afterByName.get(bc.fullName);

        if (!ac) {
          // Test vanished. Deleting a test is sometimes correct, so this is
          // reported at medium unless production changed alongside it.
          if (!after) continue; // whole file deleted; reported once below
          findings.push({
            ruleId: "test-disabled",
            severity: linkedProd.length > 0 ? "high" : "medium",
            class: "review",
            confidence: 0.85,
            file: entry.file.path,
            line: 1,
            ...(linkedProd[0] ? { productionFile: linkedProd[0] } : {}),
            testName: bc.fullName,
            message: `Test "${bc.name}" was removed.`,
            rationale:
              linkedProd.length > 0
                ? `Production code it exercised (${linkedProd.join(", ")}) changed in the same commit. The suite got greener by having one fewer thing to check.`
                : "The suite reports fewer failures because it now checks less.",
            evidence: [
              {
                label: "Removed test",
                before: `${bc.fullName} (${bc.assertions.length} assertion${bc.assertions.length === 1 ? "" : "s"})`,
              },
            ],
          });
          continue;
        }

        if (ac.modifier === "skip" || ac.modifier === "todo" || ac.modifier === "failing") {
          findings.push({
            ruleId: "test-disabled",
            severity: "high",
            class: "review",
            confidence: 0.97,
            file: entry.file.path,
            line: ac.line,
            ...(linkedProd[0] ? { productionFile: linkedProd[0] } : {}),
            testName: ac.fullName,
            message: `Test was switched to \`${ac.modifier}\` in this change.`,
            rationale:
              linkedProd.length > 0
                ? `Production code it exercised (${linkedProd.join(", ")}) changed in the same commit, so this is the shape of a failing test being silenced rather than fixed.`
                : "A test that used to run no longer runs. The suite is green because this check was turned off.",
            evidence: [
              { label: "Test", before: `active (${bc.assertions.length} assertions)`, after: ac.modifier },
            ],
          });
        }
      }
    }

    return findings;
  },
};

export const exceptionBroadened: Rule = {
  id: "exception-broadened",
  title: "A specific error expectation became a broad one",
  uniqueness:
    "Both forms are valid. Only the transition shows that the test stopped caring which error is raised.",
  defaultSeverity: "medium",
  baseConfidence: 0.85,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      const { before, after } = entry;
      if (!before || !after) continue;
      const afterByName = new Map(after.cases.map((c) => [c.fullName, c] as const));

      for (const bc of before.cases) {
        const ac = afterByName.get(bc.fullName);
        if (!ac) continue;

        const bErrors = bc.assertions.filter((a) => a.aspect === "error");
        const aErrors = ac.assertions.filter((a) => a.aspect === "error");
        const n = Math.min(bErrors.length, aErrors.length);

        for (let i = 0; i < n; i += 1) {
          const b = bErrors[i]!;
          const a = aErrors[i]!;
          const bSpec = errorSpecificity(b);
          const aSpec = errorSpecificity(a);
          if (aSpec >= bSpec) continue;

          findings.push({
            ruleId: "exception-broadened",
            severity: aSpec === 0 ? "medium" : "low",
            class: "review",
            confidence: 0.85,
            file: entry.file.path,
            line: a.line,
            testName: ac.fullName,
            message:
              aSpec === 0
                ? "Error expectation no longer says which error is expected."
                : "Error expectation became less specific.",
            rationale:
              "A bare `toThrow()` passes for a TypeError from a typo just as happily as for the domain error the test is named after.",
            evidence: [{ label: "Assertion", before: b.raw, after: a.raw }],
          });
        }
      }
    }

    return findings;
  },
};

/** 0 = bare throw, 1 = type only, 2 = message/pattern, 3 = type + message. */
function errorSpecificity(a: Assertion): number {
  const args = a.args.filter((x) => x.kind !== "none");
  if (args.length === 0) return 0;
  const first = args[0]!;
  if (first.kind === "string" || first.kind === "regexp") return 2;
  if (first.raw === "Error") return 1;
  if (first.kind === "identifier" || first.kind === "call") return args.length > 1 ? 3 : 2;
  return 1;
}

export const snapshotReplacedAssertion: Rule = {
  id: "snapshot-replaced-assertion",
  title: "Behavioural assertions were replaced by a snapshot",
  uniqueness:
    "A snapshot test is perfectly idiomatic on its own. Only the before state shows that explicit expectations used to exist and were traded for a serialised blob.",
  defaultSeverity: "high",
  baseConfidence: 0.88,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      const { before, after } = entry;
      if (!before || !after) continue;
      const afterByName = new Map(after.cases.map((c) => [c.fullName, c] as const));

      for (const bc of before.cases) {
        const ac = afterByName.get(bc.fullName);
        if (!ac) continue;

        const bSnap = bc.assertions.filter((a) => isSnapshotMatcher(a.matcher)).length;
        const aSnap = ac.assertions.filter((a) => isSnapshotMatcher(a.matcher)).length;
        const bValue = bc.assertions.filter((a) => a.aspect === "value").length;
        const aValue = ac.assertions.filter((a) => a.aspect === "value").length;

        if (aSnap > bSnap && aValue < bValue) {
          findings.push({
            ruleId: "snapshot-replaced-assertion",
            severity: aValue === 0 ? "high" : "medium",
            class: "review",
            confidence: 0.88,
            file: entry.file.path,
            line: ac.line,
            testName: ac.fullName,
            message: `${bValue - aValue} value assertion${bValue - aValue === 1 ? "" : "s"} replaced by a snapshot.`,
            rationale:
              "A snapshot asserts that behaviour has not changed since the snapshot was written. It cannot assert that the behaviour is correct, and it is regenerated with `-u` whenever it fails.",
            evidence: [
              { label: "Value assertions", before: String(bValue), after: String(aValue) },
              { label: "Snapshot assertions", before: String(bSnap), after: String(aSnap) },
            ],
          });
        }
      }
    }

    return findings;
  },
};

export const coverageIgnoreAdded: Rule = {
  id: "coverage-ignore-added",
  title: "A coverage-suppression pragma was added to production code",
  uniqueness:
    "Lives in production source, so test linters never look at it. Coverage reports go *up* as a direct result, which is exactly why it is worth surfacing.",
  defaultSeverity: "medium",
  baseConfidence: 0.95,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.production) {
      const added = newSignals(entry.before, entry.after, "coverage-ignore");
      for (const s of added) {
        findings.push({
          ruleId: "coverage-ignore-added",
          severity: "medium",
          class: "review",
          confidence: 0.95,
          file: entry.file.path,
          line: s.line,
          message: "Coverage suppression pragma added.",
          rationale:
            "Coverage percentage rises because this code stopped being measured, not because it became tested.",
          evidence: [{ label: "Added", after: s.text }],
        });
      }
    }
    return findings;
  },
};

export const testOnlyProductionPath: Rule = {
  id: "test-only-production-path",
  title: "Production code gained a branch that behaves differently under test",
  uniqueness:
    "The defect is in production source, introduced to make tests pass. No test linter reads production files, and the test suite is green by construction.",
  defaultSeverity: "high",
  baseConfidence: 0.9,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.production) {
      const added = newSignals(entry.before, entry.after, "test-environment-branch");
      for (const s of added) {
        findings.push({
          ruleId: "test-only-production-path",
          severity: "high",
          class: "review",
          confidence: 0.9,
          file: entry.file.path,
          line: s.line,
          message: "Production code now branches on the test environment.",
          rationale:
            "Whatever the tests exercise from here on is not the code path that runs in production. The suite can be fully green while the shipped behaviour is untested.",
          evidence: [{ label: "Added", after: s.text }],
        });
      }
    }
    return findings;
  },
};

function newSignals(
  before: ProductionFileModel | undefined,
  after: ProductionFileModel | undefined,
  kind: string,
): Array<{ line: number; text: string }> {
  if (!after) return [];
  const beforeTexts = new Set((before?.signals ?? []).filter((s) => s.kind === kind).map((s) => s.text));
  return after.signals
    .filter((s) => s.kind === kind && !beforeTexts.has(s.text))
    .map((s) => ({ line: s.line, text: s.text }));
}

/**
 * Rule: mock-scope-expanded
 *
 * A test that used to call real code now mocks the module it is named after.
 * This is the "mock the thing until it stops failing" move.
 */
export const mockScopeExpanded: Rule = {
  id: "mock-scope-expanded",
  title: "A test began mocking the module it is supposed to be testing",
  uniqueness:
    "Requires knowing the module under test (from the filename and import graph) and comparing mock declarations across revisions.",
  defaultSeverity: "high",
  baseConfidence: 0.8,
  diffAware: true,

  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const entry of ctx.tests) {
      const { before, after } = entry;
      if (!before || !after) continue;

      const beforeTargets = new Set(before.moduleMocks.map((m) => m.moduleTarget).filter(Boolean) as string[]);
      const newMocks = after.moduleMocks.filter((m) => m.moduleTarget && !beforeTargets.has(m.moduleTarget));
      if (newMocks.length === 0) continue;

      const linked = ctx.testToProduction.get(entry.file.path) ?? [];
      for (const m of newMocks) {
        const target = m.moduleTarget!;
        // Does the newly mocked specifier point at the module under test?
        const isSubject = linked.some((p) => {
          const stem = p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
          const spec = target.replace(/^\.\//, "").replace(/\.(ts|js)$/, "");
          return stem.endsWith(spec) || stem.endsWith(`/${spec}`);
        });
        if (!isSubject) continue;

        findings.push({
          ruleId: "mock-scope-expanded",
          severity: "high",
          class: "review",
          confidence: 0.8,
          file: entry.file.path,
          line: m.line,
          testName: undefined,
          message: `Test now mocks \`${target}\`, which is the module it imports as its subject.`,
          rationale:
            "Once the subject is mocked, the test exercises the mock's behaviour. It will stay green no matter what the real implementation does.",
          evidence: [{ label: "Added mock", after: m.raw }],
        });
      }
    }

    return findings;
  },
};
