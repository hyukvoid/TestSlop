/**
 * Computes the POC-01 independent-agent base rate from the recorded runs, and dumps
 * the material needed for the manual false-negative review.
 *
 * The base rate is the number POC-01 exists to produce:
 *
 *   in what fraction of realistic, successfully completed agent tasks does TestSlop
 *   surface something a reviewer would have wanted to know?
 *
 * Usage:
 *   node --experimental-strip-types scripts/agent-report.ts
 *   node --experimental-strip-types scripts/agent-report.ts --diffs   # review dump
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_TASKS } from "../corpus/agent-tasks/index.ts";
import type { AgentRunRecord } from "./agent-bench.ts";
import { MANUAL_REVIEW } from "../corpus/agent-tasks/review.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const RESULTS = path.join(ROOT, "work", "agentbench-results");

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function loadRecords(): Promise<AgentRunRecord[]> {
  const files = (await readdir(RESULTS)).filter((f) => f.endsWith(".json"));
  const out: AgentRunRecord[] = [];
  for (const f of files.sort()) {
    const raw = JSON.parse(await readFile(path.join(RESULTS, f), "utf8"));
    if (raw.taskId && raw.outcome) out.push(raw as AgentRunRecord);
  }
  return out;
}

/** Counts test cases added and assertions added, from the diff, for context. */
function diffStats(diff: string): { addedTestCases: number; addedAssertions: number; removedAssertions: number } {
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const removed = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  const countTests = (ls: string[]): number =>
    ls.filter((l) => /\b(it|test)(\.\w+)?\s*(\.each\s*\(|\()/.test(l)).length;
  const countAsserts = (ls: string[]): number =>
    ls.filter((l) => /\bexpect\s*\(|\.should\b|\bassert\b/.test(l)).length;
  return {
    addedTestCases: countTests(added),
    addedAssertions: countAsserts(added),
    removedAssertions: countAsserts(removed),
  };
}

async function main(): Promise<void> {
  const records = await loadRecords();
  const dumpDiffs = process.argv.includes("--diffs");

  if (dumpDiffs) {
    const parts: string[] = [];
    for (const r of records) {
      parts.push("=".repeat(100));
      parts.push(`${r.taskId}   [${r.category}, prior: ${r.prior}]`);
      parts.push(`outcome: ${r.outcome}   tests: ${r.testSummary}   findings: ${r.findings.length}`);
      parts.push("=".repeat(100));
      parts.push(r.prompt);
      parts.push("-".repeat(100));
      parts.push(r.diff);
      parts.push("");
    }
    await writeFile(path.join(ROOT, "work", "agent-diffs.txt"), parts.join("\n"), "utf8");
    process.stderr.write(`Wrote work/agent-diffs.txt (${records.length} runs)\n`);
    return;
  }

  const out: string[] = [""];
  out.push("POC-01 independent-agent benchmark");
  out.push("=".repeat(104));
  const agent = records[0]?.agent;
  out.push(`Agent: ${agent?.name ?? "?"} ${agent?.version ?? ""}   model: ${agent?.model ?? "?"}`);
  out.push(`Base repository: corpus/agent-base (order-service, 45 existing tests)`);
  out.push("");

  out.push(
    pad("task", 36) + pad("category", 18) + pad("prior", 14) + pad("outcome", 20) + pad("find", 6) + "review",
  );
  out.push("-".repeat(104));

  let completed = 0;
  let withTestChanges = 0;
  let withFindings = 0;
  let agentFailed = 0;
  let testsRed = 0;
  let noTests = 0;
  const reviewCounts: Record<string, number> = {};

  for (const r of records) {
    const review = MANUAL_REVIEW[r.taskId];
    const verdict = review?.verdict ?? "not-reviewed";
    reviewCounts[verdict] = (reviewCounts[verdict] ?? 0) + 1;

    out.push(
      pad(r.taskId, 36) +
        pad(r.category, 18) +
        pad(r.prior, 14) +
        pad(r.outcome, 20) +
        pad(r.findings.length, 6) +
        verdict,
    );

    if (r.outcome === "agent-failed") agentFailed += 1;
    else if (r.outcome === "tests-red") testsRed += 1;
    else if (r.outcome === "completed-no-tests") {
      noTests += 1;
      completed += 1;
    } else {
      completed += 1;
      withTestChanges += 1;
    }
    if (r.findings.length > 0) withFindings += 1;
  }

  out.push("-".repeat(104));
  out.push("");
  out.push("Outcomes");
  out.push("-".repeat(104));
  out.push(`  tasks attempted                          ${records.length}`);
  out.push(`  agent failed to produce a diff           ${agentFailed}`);
  out.push(`  agent left the suite failing             ${testsRed}`);
  out.push(`  completed, production only (no tests)    ${noTests}`);
  out.push(`  completed with test changes              ${withTestChanges}`);
  out.push(`  completed successfully (total)           ${completed}`);
  out.push("");

  out.push("TestSlop findings");
  out.push("-".repeat(104));
  out.push(`  tasks with any finding                   ${withFindings}`);
  const base = withTestChanges || 1;
  out.push(
    `  base rate (findings / completed w/ tests) ${withFindings}/${withTestChanges} = ${((withFindings / base) * 100).toFixed(1)}%`,
  );
  const high = records.reduce((n, r) => n + r.findings.filter((f) => f.severity === "high").length, 0);
  out.push(`  high-severity findings                   ${high}`);
  out.push("");

  out.push("Manual review of the agent's tests, performed independently of TestSlop");
  out.push("-".repeat(104));
  for (const [verdict, n] of Object.entries(reviewCounts).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${pad(verdict, 34)} ${n}`);
  }
  out.push("");

  const missed = Object.entries(MANUAL_REVIEW).filter(([, v]) => v.missedWeakness);
  if (missed.length > 0) {
    out.push("Weaknesses found by manual review that TestSlop did NOT report (false negatives)");
    out.push("-".repeat(104));
    for (const [id, v] of missed) {
      out.push(`  ${id}`);
      out.push(`    weakness: ${v.missedWeakness}`);
      out.push(`    why missed: ${v.missReason}`);
    }
    out.push("");
  }

  out.push("Prior calibration (pre-registered expectation vs measured outcome)");
  out.push("-".repeat(104));
  for (const prior of ["expect-risk", "uncertain", "expect-clean"]) {
    const group = records.filter((r) => r.prior === prior);
    const hits = group.filter((r) => r.findings.length > 0).length;
    out.push(`  ${pad(prior, 16)} ${group.length} tasks, ${hits} produced findings`);
  }
  out.push("");

  out.push("Diff size, for context on whether the agent did real work");
  out.push("-".repeat(104));
  out.push(pad("task", 36) + pad("+tests", 9) + pad("+asserts", 11) + "-asserts");
  for (const r of records) {
    const s = diffStats(r.diff);
    out.push(pad(r.taskId, 36) + pad(s.addedTestCases, 9) + pad(s.addedAssertions, 11) + String(s.removedAssertions));
  }
  const totals = records.reduce(
    (acc, r) => {
      const s = diffStats(r.diff);
      return {
        t: acc.t + s.addedTestCases,
        a: acc.a + s.addedAssertions,
        d: acc.d + s.removedAssertions,
      };
    },
    { t: 0, a: 0, d: 0 },
  );
  out.push("-".repeat(104));
  out.push(pad("TOTAL", 36) + pad(totals.t, 9) + pad(totals.a, 11) + String(totals.d));
  out.push("");

  process.stdout.write(out.join("\n") + "\n");
}

await main();
