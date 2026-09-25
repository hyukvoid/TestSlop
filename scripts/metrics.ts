/**
 * Aggregates measurements produced by the evaluation and repository-analysis scripts.
 *
 * Reads the JSON artefacts produced by the other scripts rather than re-running
 * them, so the report and the raw data cannot drift apart.
 *
 * Usage:
 *   node --experimental-strip-types scripts/metrics.ts
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../src/core/types.ts";
import type { EvaluationReport } from "./evaluate.ts";
import type { RepoReport } from "./real-world.ts";

const WORK = path.resolve(import.meta.dirname, "..", "work");

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path.join(WORK, file), "utf8")) as T;
  } catch {
    return undefined;
  }
}

function severityCounts(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function main(): Promise<void> {
  const lines: string[] = [];
  const push = (s = ""): void => void lines.push(s);

  push();
  push("TestSlop POC-00 - consolidated metrics");
  push("=".repeat(84));

  // -- Corpus (A / B / D) ----------------------------------------------------
  const evalReport = await readJson<EvaluationReport>("eval-final.json");
  if (evalReport) {
    const t = evalReport.totals;
    push();
    push("Synthetic corpus (author-written; measures rule behaviour, not precision)");
    push("-".repeat(84));
    push(`  cases                       ${t.cases}   (A ${t.byCategory.A ?? 0}, B ${t.byCategory.B ?? 0}, D ${t.byCategory.D ?? 0})`);
    push(`  expected rule instances     ${t.expectedRuleInstances}`);
    push(`  detected / missed           ${t.detected} / ${t.missed}`);
    push(`  false positives             ${t.falsePositives}`);
    push(`  grey-zone (tolerated)       ${t.tolerated}`);
    push(`  clean cases fully silent    ${t.cleanCasesWithZeroFindings}/${t.cleanCases}`);
    push(`  median scan time            ${t.staticMsMedian} ms`);
  }

  // -- Real history (C) ------------------------------------------------------
  const files = (await readdir(WORK)).filter((f) => /^(F|G)-.*\.json$/.test(f));
  // Prefer the newest artefact per repository.
  const latest = new Map<string, string>();
  for (const f of files.sort()) {
    const repo = f.replace(/^[FG]-/, "").replace(/\.json$/, "");
    latest.set(repo, f);
  }

  const repoReports: RepoReport[] = [];
  for (const [, file] of latest) {
    const r = await readJson<RepoReport[]>(file);
    if (r?.[0]) repoReports.push(r[0]);
  }

  if (repoReports.length > 0) {
    push();
    push("Real repository history (held out; measures precision in practice)");
    push("-".repeat(84));
    push(
      "  " + pad("repo", 10) + pad("commits", 9) + pad("w/find", 8) + pad("rate", 7) +
        pad("findings", 10) + pad("high", 6) + pad("high/100", 10) + "median ms",
    );

    let commits = 0;
    let withFindings = 0;
    let total = 0;
    let high = 0;
    const byRule: Record<string, number> = {};
    const byRuleHigh: Record<string, number> = {};

    for (const r of repoReports.sort((a, b) => a.repo.localeCompare(b.repo))) {
      const all = r.scans.flatMap((s) => s.findings);
      const sev = severityCounts(all);
      const rate = r.scanned ? (r.totals.commitsWithFindings / r.scanned) * 100 : 0;
      const highRate = r.scanned ? (sev.high! / r.scanned) * 100 : 0;
      push(
        "  " + pad(r.repo, 10) + pad(r.scanned, 9) + pad(r.totals.commitsWithFindings, 8) +
          pad(`${rate.toFixed(0)}%`, 7) + pad(all.length, 10) + pad(sev.high!, 6) +
          pad(highRate.toFixed(1), 10) + String(r.totals.durationMsMedian),
      );
      commits += r.scanned;
      withFindings += r.totals.commitsWithFindings;
      total += all.length;
      high += sev.high!;
      for (const f of all) {
        byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
        if (f.severity === "high") byRuleHigh[f.ruleId] = (byRuleHigh[f.ruleId] ?? 0) + 1;
      }
    }

    push("  " + "-".repeat(80));
    push(
      "  " + pad("TOTAL", 10) + pad(commits, 9) + pad(withFindings, 8) +
        pad(`${((withFindings / commits) * 100).toFixed(0)}%`, 7) + pad(total, 10) + pad(high, 6) +
        pad(((high / commits) * 100).toFixed(1), 10),
    );
    push();
    push(`  findings per commit                 ${(total / commits).toFixed(2)}`);
    push(`  high-severity findings per commit   ${(high / commits).toFixed(3)}`);
    push(`  commits a developer would see       ${((withFindings / commits) * 100).toFixed(0)}%`);
    push();
    push("  By rule (all severities / high only)");
    for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
      push(`    ${pad(rule, 34)} ${pad(n, 6)} ${byRuleHigh[rule] ?? 0}`);
    }
  }

  // -- Mutation --------------------------------------------------------------
  const mutation = await readJson<EvaluationReport>("eval-mutate-final.json");
  if (mutation) {
    push();
    push("Targeted mutation");
    push("-".repeat(84));
    for (const c of mutation.cases) {
      if (!c.mutationSummary) continue;
      const verdict =
        c.mutationExpectedSurvivor === undefined ? "-"
        : c.mutationExpectedSurvivor === ((c.mutationSurvivors ?? 0) > 0) ? "as predicted"
        : "PREDICTION MISSED";
      push(`  ${pad(c.id, 34)} ${c.mutationSummary}`);
      push(`  ${" ".repeat(34)} survivors ${c.mutationSurvivors ?? 0}  (${verdict})`);
    }
    const totalMs = mutation.cases.reduce((n, c) => n + (c.mutationMs ?? 0), 0);
    const withMutation = mutation.cases.filter((c) => c.mutationMs !== undefined).length;
    if (withMutation > 0) {
      push();
      push(`  cases with mutation enabled   ${withMutation}`);
      push(`  total mutation wall time      ${(totalMs / 1000).toFixed(1)} s`);
      push(`  average per case              ${(totalMs / withMutation / 1000).toFixed(1)} s`);
    }
  }

  // -- Lint comparison -------------------------------------------------------
  const lint = await readJson<Array<{ id: string; category: string; findingCount: number; eslintCount: number; eslintRules: string[] }>>(
    "lint-compare.json",
  );
  if (lint) {
    const clean = lint.filter((r) => r.category === "B");
    const dirty = lint.filter((r) => r.category !== "B");
    push();
    push("eslint-plugin-jest comparison (all rules enabled, fixtures shown as jest globals)");
    push("-".repeat(84));
    push(`  degraded cases (A+D):  TestSlop ${dirty.reduce((n, r) => n + r.findingCount, 0)}   ESLint ${dirty.reduce((n, r) => n + r.eslintCount, 0)}`);
    push(`  clean cases (B):       TestSlop ${clean.reduce((n, r) => n + r.findingCount, 0)}   ESLint ${clean.reduce((n, r) => n + r.eslintCount, 0)}`);
    push(`  ESLint fired on ${clean.filter((r) => r.eslintCount > 0).length}/${clean.length} clean cases; TestSlop on ${clean.filter((r) => r.findingCount > 0).length}/${clean.length}`);
  }

  push();
  process.stdout.write(lines.join("\n") + "\n");
}

await main();
