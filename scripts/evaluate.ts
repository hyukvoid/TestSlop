/**
 * Evaluation harness.
 *
 * Builds every corpus case as a real git repository, runs the analyser against
 * the `base..head` diff, and scores the findings against the ground truth
 * recorded in the case definition.
 *
 * Scoring vocabulary:
 *   detected        an expected rule fired
 *   missed          an expected rule did not fire
 *   falsePositive   a rule fired that the case forbids
 *   tolerated       a rule fired that the case marks as defensible-but-noisy
 *
 * `forbidden: ["*"]` means "nothing at all should fire", which is how Category B
 * cases assert precision.
 *
 * Usage:
 *   node --experimental-strip-types scripts/evaluate.ts            # static only
 *   node --experimental-strip-types scripts/evaluate.ts --mutate   # + mutation
 *   node --experimental-strip-types scripts/evaluate.ts --json out.json
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { collectChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import { listFilesAtRef } from "../src/core/git.ts";
import { runMutationExperiment, mutationFindings, summariseMutation } from "../src/mutation/verify.ts";
import type { Finding, ScanResult } from "../src/core/types.ts";
import { ALL_RULES } from "../src/rules/index.ts";
import { ALL_CASES } from "../corpus/cases/index.ts";
import type { CorpusCase } from "../corpus/types.ts";
import { buildCase, CORPUS_ROOT } from "./build-corpus.ts";

export interface CaseScore {
  id: string;
  category: string;
  intent: string;
  detected: string[];
  missed: string[];
  falsePositives: string[];
  tolerated: string[];
  findings: Finding[];
  staticMs: number;
  mutationMs?: number;
  mutationSummary?: string;
  mutationSurvivors?: number;
  mutationExpectedSurvivor?: boolean;
  repo: string;
}

export interface EvaluationReport {
  generatedAt: string;
  cases: CaseScore[];
  totals: {
    cases: number;
    byCategory: Record<string, number>;
    expectedRuleInstances: number;
    detected: number;
    missed: number;
    falsePositives: number;
    tolerated: number;
    totalFindings: number;
    cleanCasesWithZeroFindings: number;
    cleanCases: number;
    staticMsTotal: number;
    staticMsMedian: number;
    mutationMsTotal?: number;
  };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

function scoreCase(kase: CorpusCase, result: ScanResult, repo: string, extra: Partial<CaseScore> = {}): CaseScore {
  const fired = uniq(result.findings.map((f) => f.ruleId));
  const expected = kase.expect.rules;
  const tolerated = kase.expect.tolerated ?? [];
  const forbidden = kase.expect.forbidden ?? [];
  const forbidEverything = forbidden.includes("*");

  const detected = expected.filter((r) => fired.includes(r));
  const missed = expected.filter((r) => !fired.includes(r));

  const falsePositives = fired.filter((r) => {
    if (expected.includes(r)) return false;
    if (tolerated.includes(r)) return false;
    if (r === "internal-rule-error") return true;
    if (r === "mutation-unavailable") return false;
    if (forbidEverything) return true;
    return forbidden.includes(r);
  });

  const toleratedFired = fired.filter((r) => tolerated.includes(r));

  return {
    id: kase.id,
    category: kase.category,
    intent: kase.intent,
    detected,
    missed,
    falsePositives,
    tolerated: toleratedFired,
    findings: result.findings,
    staticMs: result.summary.durationMs,
    repo,
    ...extra,
  };
}

export interface EvaluateOptions {
  mutate?: boolean;
  only?: string[];
  onProgress?: (line: string) => void;
}

export async function evaluate(opts: EvaluateOptions = {}): Promise<EvaluationReport> {
  const progress = opts.onProgress ?? (() => {});
  const selected = opts.only?.length ? ALL_CASES.filter((c) => opts.only!.includes(c.id)) : ALL_CASES;
  const scores: CaseScore[] = [];

  for (const kase of selected) {
    const repo = await buildCase(kase);
    const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD~1" });
    const knownPaths = await listFilesAtRef(repo, "HEAD").catch(() => [] as string[]);
    // The corpus characterises every rule, including experimental ones that are
    // off by default. The real-history harness (scripts/real-world.ts) uses the
    // default set instead, because that is what a user actually sees.
    const result = await analyse(changeSet, { knownPaths, rules: ALL_RULES });

    const extra: Partial<CaseScore> = {};

    if (opts.mutate && kase.mutation) {
      const report = await runMutationExperiment(changeSet, { budget: 14, timeoutMs: 120_000 });
      const survivors = mutationFindings(report).filter((f) => f.ruleId === "changed-logic-survived");
      result.findings = [...result.findings, ...survivors];
      extra.mutationMs = report.totalDurationMs;
      extra.mutationSummary = report.baseline.ok ? summariseMutation(report) : `not run: ${report.baseline.detail}`;
      extra.mutationSurvivors = survivors.length;
      extra.mutationExpectedSurvivor = kase.mutation.expectSurvivor;
    }

    const score = scoreCase(kase, result, repo, extra);
    scores.push(score);
    progress(
      `${kase.id.padEnd(42)} detected ${score.detected.length}/${kase.expect.rules.length}` +
        `  fp ${score.falsePositives.length}` +
        `  findings ${score.findings.length}` +
        `  ${score.staticMs}ms` +
        (extra.mutationSummary ? `  | ${extra.mutationSummary}` : ""),
    );
  }

  const byCategory: Record<string, number> = {};
  for (const s of scores) byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;

  const cleanCases = scores.filter((s) => {
    const kase = selected.find((c) => c.id === s.id)!;
    return kase.expect.rules.length === 0;
  });

  const staticTimes = scores.map((s) => s.staticMs).sort((a, b) => a - b);
  const median = staticTimes.length
    ? staticTimes[Math.floor(staticTimes.length / 2)]!
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    cases: scores,
    totals: {
      cases: scores.length,
      byCategory,
      expectedRuleInstances: scores.reduce((n, s) => n + s.detected.length + s.missed.length, 0),
      detected: scores.reduce((n, s) => n + s.detected.length, 0),
      missed: scores.reduce((n, s) => n + s.missed.length, 0),
      falsePositives: scores.reduce((n, s) => n + s.falsePositives.length, 0),
      tolerated: scores.reduce((n, s) => n + s.tolerated.length, 0),
      totalFindings: scores.reduce((n, s) => n + s.findings.length, 0),
      cleanCases: cleanCases.length,
      cleanCasesWithZeroFindings: cleanCases.filter((s) => s.findings.length === 0).length,
      staticMsTotal: scores.reduce((n, s) => n + s.staticMs, 0),
      staticMsMedian: median,
      ...(opts.mutate
        ? { mutationMsTotal: scores.reduce((n, s) => n + (s.mutationMs ?? 0), 0) }
        : {}),
    },
  };
}

export function renderEvaluation(report: EvaluationReport): string {
  const out: string[] = [];
  const t = report.totals;

  out.push("");
  out.push("TestSlop corpus evaluation");
  out.push("=".repeat(78));
  out.push("");

  for (const category of ["A", "B", "C", "D"]) {
    const cases = report.cases.filter((c) => c.category === category);
    if (cases.length === 0) continue;
    const label =
      category === "A" ? "Category A - deliberately degraded oracles"
      : category === "B" ? "Category B - clean lookalikes (false-positive test)"
      : category === "C" ? "Category C - real repository history"
      : "Category D - coding-agent generated changes";
    out.push(label);
    out.push("-".repeat(78));
    for (const c of cases) {
      const verdict =
        c.missed.length === 0 && c.falsePositives.length === 0 ? "PASS"
        : c.falsePositives.length > 0 ? "FP  "
        : "MISS";
      out.push(`  ${verdict}  ${c.id}`);
      if (c.detected.length) out.push(`          detected: ${c.detected.join(", ")}`);
      if (c.missed.length) out.push(`          MISSED:   ${c.missed.join(", ")}`);
      if (c.falsePositives.length) out.push(`          FALSE+:   ${c.falsePositives.join(", ")}`);
      if (c.tolerated.length) out.push(`          tolerated: ${c.tolerated.join(", ")}`);
      if (c.mutationSummary) {
        const expected = c.mutationExpectedSurvivor ? "expected a survivor" : "expected none";
        out.push(`          mutation: ${c.mutationSummary}  (${expected})`);
      }
      if (c.findings.length === 0) out.push("          no findings");
    }
    out.push("");
  }

  out.push("Totals");
  out.push("-".repeat(78));
  out.push(`  cases                        ${t.cases}  (${Object.entries(t.byCategory).map(([k, v]) => `${k}:${v}`).join("  ")})`);
  out.push(`  expected rule instances      ${t.expectedRuleInstances}`);
  out.push(`  detected                     ${t.detected}`);
  out.push(`  missed                       ${t.missed}`);
  out.push(`  false positives              ${t.falsePositives}`);
  out.push(`  tolerated (grey zone)        ${t.tolerated}`);
  out.push(`  total findings emitted       ${t.totalFindings}`);
  out.push(`  clean cases fully silent     ${t.cleanCasesWithZeroFindings}/${t.cleanCases}`);
  const recall = t.expectedRuleInstances ? (t.detected / t.expectedRuleInstances) * 100 : 0;
  out.push(`  recall on expected rules     ${recall.toFixed(0)}%`);
  out.push(`  static scan total / median   ${t.staticMsTotal} ms / ${t.staticMsMedian} ms`);
  if (t.mutationMsTotal !== undefined) {
    out.push(`  mutation total               ${t.mutationMsTotal} ms`);
  }
  out.push("");

  return out.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const mutate = args.includes("--mutate");
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
  const only = args.filter((a) => !a.startsWith("--") && a !== jsonOut);

  const report = await evaluate({
    mutate,
    only,
    onProgress: (line) => process.stderr.write(line + "\n"),
  });
  process.stdout.write(renderEvaluation(report));
  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify(report, null, 2), "utf8");
    process.stderr.write(`\nWrote ${jsonOut}\n`);
  }
  process.stderr.write(`Corpus repositories: ${CORPUS_ROOT}\n`);
}
