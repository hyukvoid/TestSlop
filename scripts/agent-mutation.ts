/**
 * Targeted mutation against the independent-agent diffs.
 *
 * The static rules reported nothing on all 24 tasks. That leaves the question the
 * brief asks directly: does mutation add evidence on independent agent output, or is
 * the agent's work genuinely well verified?
 *
 * Mutation is the only mechanism that can distinguish those two, because it executes
 * rather than infers. A mutant that survives means nothing in the agent's tests
 * notices when that decision is broken, regardless of how strong the assertions look.
 *
 * Usage: node --experimental-strip-types scripts/agent-mutation.ts [taskId...]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectChangeSet } from "../src/core/changeset.ts";
import { runMutationExperiment, mutationFindings } from "../src/mutation/verify.ts";
import type { AgentRunRecord } from "./agent-bench.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const RESULTS = path.join(ROOT, "work", "agentbench-results");
const RUNS = path.join(ROOT, "work", "agentbench");

interface MutationRow {
  taskId: string;
  mutants: number;
  killed: number;
  survived: number;
  skipped: number;
  durationMs: number;
  baselineOk: boolean;
  baselineDetail: string;
  survivors: Array<{ file: string; line: number; operator: string; from: string; to: string; enclosing?: string }>;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const files = (await readdir(RESULTS)).filter((f) => f.endsWith(".json")).sort();
  const rows: MutationRow[] = [];

  for (const f of files) {
    const record = JSON.parse(await readFile(path.join(RESULTS, f), "utf8")) as AgentRunRecord;
    if (only.length > 0 && !only.includes(record.taskId)) continue;
    // Only tasks where the agent changed production code have anything to mutate.
    if (!record.changedProductionFiles?.length) continue;

    const repo = path.join(RUNS, record.taskId);
    process.stderr.write(`${record.taskId}: mutating…\n`);

    const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD" });
    const report = await runMutationExperiment(changeSet, { budget: 14, timeoutMs: 180_000 });

    const survivors = report.outcomes
      .filter((o) => o.status === "survived")
      .map((o) => ({
        file: o.mutant.file,
        line: o.mutant.line,
        operator: o.mutant.operator,
        from: o.mutant.original,
        to: o.mutant.replacement,
        ...(o.mutant.enclosing ? { enclosing: o.mutant.enclosing } : {}),
      }));

    rows.push({
      taskId: record.taskId,
      mutants: report.outcomes.length,
      killed: report.outcomes.filter((o) => o.status === "killed").length,
      survived: survivors.length,
      skipped: report.outcomes.filter((o) => o.status === "skipped" || o.status === "error").length,
      durationMs: report.totalDurationMs,
      baselineOk: report.baseline.ok,
      baselineDetail: report.baseline.detail,
      survivors,
    });

    process.stderr.write(
      `  ${report.outcomes.length} mutants, ${survivors.length} survived, ${Math.round(report.totalDurationMs / 1000)}s\n`,
    );
  }

  await writeFile(path.join(ROOT, "work", "agent-mutation.json"), JSON.stringify(rows, null, 2), "utf8");

  const out: string[] = [""];
  out.push("Targeted mutation on independent-agent diffs");
  out.push("=".repeat(96));
  out.push(pad("task", 36) + pad("mutants", 9) + pad("killed", 8) + pad("survived", 10) + pad("skipped", 9) + "seconds");
  out.push("-".repeat(96));

  let m = 0;
  let k = 0;
  let s = 0;
  let sk = 0;
  let ms = 0;
  for (const r of rows) {
    out.push(
      pad(r.taskId, 36) +
        pad(r.mutants, 9) +
        pad(r.killed, 8) +
        pad(r.survived, 10) +
        pad(r.skipped, 9) +
        Math.round(r.durationMs / 1000),
    );
    m += r.mutants;
    k += r.killed;
    s += r.survived;
    sk += r.skipped;
    ms += r.durationMs;
  }
  out.push("-".repeat(96));
  out.push(pad("TOTAL", 36) + pad(m, 9) + pad(k, 8) + pad(s, 10) + pad(sk, 9) + Math.round(ms / 1000));
  out.push("");
  const scored = m - sk;
  out.push(`  mutation score (killed / scored)  ${k}/${scored} = ${scored ? ((k / scored) * 100).toFixed(1) : "n/a"}%`);
  out.push(`  tasks with at least one survivor  ${rows.filter((r) => r.survived > 0).length}/${rows.length}`);
  out.push(`  average wall time per task        ${rows.length ? (ms / rows.length / 1000).toFixed(1) : "0"}s`);
  out.push("");

  const withSurvivors = rows.filter((r) => r.survived > 0);
  if (withSurvivors.length > 0) {
    out.push("Surviving mutants — unverified decisions in the agent's own changed code");
    out.push("-".repeat(96));
    for (const r of withSurvivors) {
      out.push(`  ${r.taskId}`);
      for (const v of r.survivors) {
        out.push(
          `    ${v.file}:${v.line}  ${v.from} -> ${v.to}  (${v.operator}${v.enclosing ? `, in ${v.enclosing}` : ""})`,
        );
      }
    }
    out.push("");
  }

  const badBaseline = rows.filter((r) => !r.baselineOk);
  if (badBaseline.length > 0) {
    out.push("Tasks where mutation could not run");
    out.push("-".repeat(96));
    for (const r of badBaseline) out.push(`  ${r.taskId}: ${r.baselineDetail}`);
    out.push("");
  }

  process.stdout.write(out.join("\n") + "\n");
}

await main();
