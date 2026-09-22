/**
 * The analysis pipeline.
 *
 *   ChangeSet -> adapters -> AnalysisContext -> rules -> Findings
 *
 * Adapter selection is per-file and by extension. Everything downstream of the
 * adapters works on the normalised model, so adding a language means adding a
 * parser pair (test + production) and nothing else.
 */

import type {
  AnalysedProductionFile,
  AnalysedTestFile,
  AnalysisContext,
  ChangeSet,
  Finding,
  ImportRecord,
  Rule,
  ScanResult,
  Severity,
} from "./types.ts";
import { parseTestFile } from "../adapters/ts/parse-test.ts";
import { parseProductionFile } from "../adapters/ts/parse-production.ts";
import { parsePythonTestFile, parsePythonProductionFile, pythonAvailable } from "../adapters/python/index.ts";
import { buildTestToProductionMap } from "./link.ts";
import { ALL_RULES } from "../rules/index.ts";

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export interface AnalyseOptions {
  rules?: Rule[];
  /** Additional repo paths that exist at head, improving import resolution. */
  knownPaths?: string[];
  /** Drop findings below this confidence. */
  minConfidence?: number;
  /** Include Python files. Requires a python3 interpreter on PATH. */
  python?: boolean;
}

function isPython(path: string): boolean {
  return path.endsWith(".py");
}

export async function buildContext(changeSet: ChangeSet, opts: AnalyseOptions = {}): Promise<AnalysisContext> {
  const tests: AnalysedTestFile[] = [];
  const production: AnalysedProductionFile[] = [];
  const importsByTest = new Map<string, ImportRecord[]>();

  const usePython = opts.python !== false && changeSet.files.some((f) => isPython(f.path)) && (await pythonAvailable());

  for (const file of changeSet.files) {
    if (isPython(file.path) && !usePython) continue;

    if (file.role === "test") {
      const entry: AnalysedTestFile = { file };
      if (file.before !== undefined) {
        entry.before = isPython(file.path)
          ? await parsePythonTestFile(file.path, file.before)
          : parseTestFile(file.path, file.before);
      }
      if (file.after !== undefined) {
        entry.after = isPython(file.path)
          ? await parsePythonTestFile(file.path, file.after)
          : parseTestFile(file.path, file.after);
        importsByTest.set(file.path, entry.after.imports);
      } else if (entry.before) {
        importsByTest.set(file.path, entry.before.imports);
      }
      tests.push(entry);
    } else if (file.role === "production") {
      const entry: AnalysedProductionFile = { file };
      if (file.before !== undefined) {
        entry.before = isPython(file.path)
          ? await parsePythonProductionFile(file.path, file.before)
          : parseProductionFile(file.path, file.before);
      }
      if (file.after !== undefined) {
        entry.after = isPython(file.path)
          ? await parsePythonProductionFile(file.path, file.after)
          : parseProductionFile(file.path, file.after);
      }
      production.push(entry);
    }
  }

  const testToProduction = buildTestToProductionMap(changeSet, importsByTest, {
    knownPaths: opts.knownPaths ?? [],
  });

  return { changeSet, tests, production, testToProduction };
}

export function runRules(ctx: AnalysisContext, opts: AnalyseOptions = {}): Finding[] {
  const rules = opts.rules ?? ALL_RULES;
  const findings: Finding[] = [];

  for (const rule of rules) {
    try {
      findings.push(...rule.run(ctx));
    } catch (err) {
      // A rule crashing must not take the scan down; report it as a low-severity
      // diagnostic so the failure is visible rather than silently swallowed.
      findings.push({
        ruleId: "internal-rule-error",
        severity: "low",
        class: "review",
        confidence: 1,
        file: rule.id,
        line: 1,
        message: `Rule "${rule.id}" failed: ${(err as Error).message}`,
        evidence: [],
      });
    }
  }

  const min = opts.minConfidence ?? 0;
  return sortFindings(findings.filter((f) => f.confidence >= min));
}

export function sortFindings(findings: Finding[]): Finding[] {
  const ruleOrder = new Map(ALL_RULES.map((r, i) => [r.id, i] as const));
  return [...findings].sort((a, b) => {
    const sev = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
    if (sev !== 0) return sev;
    const evi = (a.class === "evidence" ? 0 : 1) - (b.class === "evidence" ? 0 : 1);
    if (evi !== 0) return evi;
    const rule = (ruleOrder.get(a.ruleId) ?? 99) - (ruleOrder.get(b.ruleId) ?? 99);
    if (rule !== 0) return rule;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

export function countChangedTestCases(ctx: AnalysisContext): number {
  let n = 0;
  for (const entry of ctx.tests) {
    if (!entry.after) {
      n += entry.before?.cases.length ?? 0;
      continue;
    }
    if (!entry.before) {
      n += entry.after.cases.length;
      continue;
    }
    const beforeByName = new Map(entry.before.cases.map((c) => [c.fullName, c] as const));
    for (const c of entry.after.cases) {
      const prior = beforeByName.get(c.fullName);
      if (!prior || prior.body.replace(/\s+/g, "") !== c.body.replace(/\s+/g, "")) n += 1;
    }
    // Tests that disappeared also count as changed.
    const afterNames = new Set(entry.after.cases.map((c) => c.fullName));
    for (const c of entry.before.cases) if (!afterNames.has(c.fullName)) n += 1;
  }
  return n;
}

export async function analyse(changeSet: ChangeSet, opts: AnalyseOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const ctx = await buildContext(changeSet, opts);
  const findings = runRules(ctx, opts);

  return {
    range: changeSet.range,
    findings,
    summary: {
      testFilesChanged: ctx.tests.length,
      productionFilesChanged: ctx.production.length,
      testCasesChanged: countChangedTestCases(ctx),
      findings: findings.length,
      durationMs: Date.now() - started,
    },
  };
}
