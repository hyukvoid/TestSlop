/**
 * Re-runs changed-behaviour verification over the POC-01 agent benchmark with the
 * POC-02 engine, so the two can be compared directly on identical diffs.
 *
 * This is the measurement Goal A stands or falls on. POC-01's numbers were:
 *   93 mutants, 19 survivors, 11/22 tasks with a survivor,
 *   10 clear true positives / 5 equivalent / 4 low-value.
 *
 * Usage:
 *   node --experimental-strip-types scripts/agent-verify.ts [--weak] [taskId...]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectChangeSet } from "../src/core/changeset.ts";
import { verifyChangedBehaviour, type AlternativeResult } from "../src/mutation/behaviour-verify.ts";
import type { AgentRunRecord } from "./agent-bench.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface VerifyRow {
  taskId: string;
  generated: number;
  afterDedup: number;
  executed: number;
  caught: number;
  unverified: number;
  caughtElsewhere: number;
  baselineOk: boolean;
  baselineDetail: string;
  timing: { totalMs: number; sandboxMs: number; baselineMs: number; executionMs: number; fullSuiteMs: number };
  findings: Array<{
    file: string;
    line: number;
    kind: string;
    confidence: string;
    edit: string;
    context: string;
    distinguishing: string;
    enclosing?: string;
    outcome: string;
    testedWith: string[];
    caughtBy?: string;
  }>;
}

function row(result: AlternativeResult): VerifyRow["findings"][number] {
  const a = result.alternative;
  return {
    file: a.file,
    line: a.line,
    kind: a.kind,
    confidence: a.confidence,
    edit: `${a.original} -> ${a.replacement}`,
    context: a.context,
    distinguishing: a.distinguishing.description,
    ...(a.enclosing ? { enclosing: a.enclosing } : {}),
    outcome: result.outcome,
    testedWith: result.testedWith,
    ...(result.caughtBy ? { caughtBy: result.caughtBy } : {}),
  };
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const weak = args.includes("--weak");
  const only = args.filter((a) => !a.startsWith("--"));

  const resultsDir = path.join(ROOT, "work", weak ? "agentbench-results-weak" : "agentbench-results");
  const runsDir = path.join(ROOT, "work", weak ? "agentbench-weak" : "agentbench");
  const outFile = path.join(ROOT, "work", weak ? "p2-verify-weak.json" : "p2-verify.json");

  const files = (await readdir(resultsDir)).filter((f) => f.endsWith(".json")).sort();
  const rows: VerifyRow[] = [];

  for (const f of files) {
    const record = JSON.parse(await readFile(path.join(resultsDir, f), "utf8")) as AgentRunRecord;
    if (only.length > 0 && !only.includes(record.taskId)) continue;
    if (!record.changedProductionFiles?.length) continue;

    const repo = path.join(runsDir, record.taskId);
    process.stderr.write(`${record.taskId}: verifying…\n`);

    const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD" });
    const report = await verifyChangedBehaviour(changeSet, { budget: 12, timeoutMs: 240_000 });

    rows.push({
      taskId: record.taskId,
      generated: report.counts.generated,
      afterDedup: report.counts.deduplicated,
      executed: report.counts.executed,
      caught: report.counts.caught,
      unverified: report.counts.unverified,
      caughtElsewhere: report.counts.caughtElsewhere,
      baselineOk: report.baseline.ok,
      baselineDetail: report.baseline.detail,
      timing: report.timing,
      findings: report.results.filter((r) => r.outcome !== "caught").map(row),
    });

    process.stderr.write(
      `  ${report.counts.generated} -> ${report.counts.deduplicated} -> ${report.counts.executed} executed, ` +
        `${report.counts.unverified} unverified, ${report.counts.caughtElsewhere} elsewhere, ` +
        `${Math.round(report.timing.totalMs / 1000)}s\n`,
    );
  }

  await writeFile(outFile, JSON.stringify(rows, null, 2), "utf8");

  const out: string[] = [""];
  out.push(`POC-02 changed-behaviour verification — ${weak ? "weak-style arm" : "main arm"}`);
  out.push("=".repeat(108));
  out.push(
    pad("task", 36) + pad("gen", 6) + pad("dedup", 7) + pad("exec", 6) + pad("caught", 8) +
      pad("UNVER", 7) + pad("elsew", 7) + "sec",
  );
  out.push("-".repeat(108));

  const t = { gen: 0, dedup: 0, exec: 0, caught: 0, unver: 0, elsew: 0, ms: 0 };
  for (const r of rows) {
    out.push(
      pad(r.taskId, 36) + pad(r.generated, 6) + pad(r.afterDedup, 7) + pad(r.executed, 6) +
        pad(r.caught, 8) + pad(r.unverified, 7) + pad(r.caughtElsewhere, 7) +
        (r.timing.totalMs / 1000).toFixed(0),
    );
    t.gen += r.generated;
    t.dedup += r.afterDedup;
    t.exec += r.executed;
    t.caught += r.caught;
    t.unver += r.unverified;
    t.elsew += r.caughtElsewhere;
    t.ms += r.timing.totalMs;
  }
  out.push("-".repeat(108));
  out.push(
    pad("TOTAL", 36) + pad(t.gen, 6) + pad(t.dedup, 7) + pad(t.exec, 6) + pad(t.caught, 8) +
      pad(t.unver, 7) + pad(t.elsew, 7) + (t.ms / 1000).toFixed(0),
  );
  out.push("");
  out.push(`  tasks                              ${rows.length}`);
  out.push(`  tasks with an unverified behaviour ${rows.filter((r) => r.unverified > 0).length}`);
  out.push(`  tasks with a linking miss only     ${rows.filter((r) => r.unverified === 0 && r.caughtElsewhere > 0).length}`);
  out.push(`  generation reduced by dedup        ${t.gen} -> ${t.dedup} (${t.gen ? Math.round((1 - t.dedup / t.gen) * 100) : 0}% fewer)`);
  out.push(`  mean wall time per task            ${rows.length ? (t.ms / rows.length / 1000).toFixed(1) : "0"}s`);
  out.push("");

  const withFindings = rows.filter((r) => r.findings.length > 0);
  if (withFindings.length > 0) {
    out.push("Findings");
    out.push("-".repeat(108));
    for (const r of withFindings) {
      out.push(`  ${r.taskId}`);
      for (const f of r.findings) {
        const tag = f.outcome === "unverified" ? "UNVERIFIED" : f.outcome.toUpperCase();
        out.push(`    [${tag}] ${f.confidence.padEnd(6)} ${f.file}:${f.line}  ${f.edit}`);
        out.push(`             unconstrained: ${f.distinguishing}`);
        out.push(`             code: ${f.context.slice(0, 84)}`);
        if (f.caughtBy) out.push(`             caught by: ${f.caughtBy}`);
      }
    }
    out.push("");
  }

  process.stdout.write(out.join("\n") + "\n");
}

await main();
