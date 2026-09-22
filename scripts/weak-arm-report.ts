/**
 * Style-contagion comparison.
 *
 * Same agent, same task prompts, same production code. The only difference is whether
 * the repository's *existing* tests are written with exact expectations or with
 * existence checks.
 *
 * If the benchmark's zero-weak-assertion result is a property of the agent, the two
 * arms should look alike. If it is a property of the surrounding code, the weak arm
 * should regress.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseTestFile } from "../src/adapters/ts/parse-test.ts";
import { pairTestCases } from "../src/core/pairing.ts";
import { showFile } from "../src/core/git.ts";
import { strengthRank } from "../src/core/types.ts";
import type { AgentRunRecord } from "./agent-bench.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WEAK_AT_OR_BELOW = strengthRank("EXISTENCE");

interface ArmStats {
  arm: string;
  tasks: number;
  tests: number;
  assertions: number;
  byStrength: Record<string, number>;
  weakAssertions: number;
  findings: number;
  weakExamples: string[];
}

async function analyseArm(resultsDir: string, runsDir: string, arm: string, only?: Set<string>): Promise<ArmStats> {
  const stats: ArmStats = {
    arm,
    tasks: 0,
    tests: 0,
    assertions: 0,
    byStrength: {},
    weakAssertions: 0,
    findings: 0,
    weakExamples: [],
  };

  let files: string[];
  try {
    files = (await readdir(resultsDir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return stats;
  }

  for (const f of files) {
    const r = JSON.parse(await readFile(path.join(resultsDir, f), "utf8")) as AgentRunRecord;
    if (only && !only.has(r.taskId)) continue;
    stats.tasks += 1;
    stats.findings += r.findings?.length ?? 0;

    for (const rel of r.changedTestFiles ?? []) {
      const repo = path.join(runsDir, r.taskId);
      const after = await readFile(path.join(repo, rel), "utf8").catch(() => undefined);
      if (after === undefined) continue;
      // The base revision, so that only assertions the *agent* wrote are counted.
      // Counting the whole file at head conflates the agent's work with the
      // pre-existing suite, which in the weak arm is deliberately full of existence
      // checks and would have manufactured the result this experiment is testing for.
      const before = await showFile(repo, "HEAD", rel);
      const afterModel = parseTestFile(rel, after);
      const beforeModel = before === undefined ? undefined : parseTestFile(rel, before);

      const pairing = pairTestCases(beforeModel?.cases ?? [], afterModel.cases);
      const priorAssertions = new Set<string>();
      for (const p of pairing.pairs) for (const a of p.before.assertions) priorAssertions.add(a.raw);

      // Assertions in genuinely new tests, plus assertions newly added to tests that
      // already existed.
      const agentAssertions = [
        ...pairing.added.flatMap((c) => c.assertions.map((a) => ({ a, test: c.name }))),
        ...pairing.pairs.flatMap((p) =>
          p.after.assertions.filter((a) => !priorAssertions.has(a.raw)).map((a) => ({ a, test: p.after.name })),
        ),
      ];

      stats.tests += pairing.added.length;
      for (const { a } of agentAssertions) {
        stats.assertions += 1;
        stats.byStrength[a.strength] = (stats.byStrength[a.strength] ?? 0) + 1;
        if (strengthRank(a.strength) <= WEAK_AT_OR_BELOW) {
          stats.weakAssertions += 1;
          if (stats.weakExamples.length < 14) {
            stats.weakExamples.push(`${r.taskId}  ${a.strength.padEnd(10)} ${a.raw.slice(0, 72)}`);
          }
        }
      }
    }
  }
  return stats;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function main(): Promise<void> {
  const weakDir = path.join(ROOT, "work", "agentbench-results-weak");
  const weakRuns = path.join(ROOT, "work", "agentbench-weak");
  const strongDir = path.join(ROOT, "work", "agentbench-results");
  const strongRuns = path.join(ROOT, "work", "agentbench");

  // Compare only the tasks that were actually run in the weak arm.
  const weakIds = new Set(
    (await readdir(weakDir).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, "")),
  );

  const weak = await analyseArm(weakDir, weakRuns, "weak existing tests", weakIds);
  const strong = await analyseArm(strongDir, strongRuns, "strong existing tests", weakIds);

  const out: string[] = [""];
  out.push("Style contagion: does the agent imitate the repository's test style?");
  out.push("=".repeat(92));
  out.push(`Matched on the ${weakIds.size} tasks run in both arms.`);
  out.push("");
  out.push(pad("arm", 26) + pad("tasks", 8) + pad("tests", 8) + pad("asserts", 10) + pad("weak", 8) + pad("% weak", 9) + "findings");
  out.push("-".repeat(92));
  for (const s of [strong, weak]) {
    out.push(
      pad(s.arm, 26) +
        pad(s.tasks, 8) +
        pad(s.tests, 8) +
        pad(s.assertions, 10) +
        pad(s.weakAssertions, 8) +
        pad(s.assertions ? `${((s.weakAssertions / s.assertions) * 100).toFixed(1)}%` : "n/a", 9) +
        String(s.findings),
    );
  }
  out.push("");
  out.push("Strength distribution");
  out.push("-".repeat(92));
  const keys = [...new Set([...Object.keys(strong.byStrength), ...Object.keys(weak.byStrength)])].sort(
    (a, b) => strengthRank(b as never) - strengthRank(a as never),
  );
  out.push(pad("class", 16) + pad("strong arm", 14) + "weak arm");
  for (const k of keys) {
    out.push(pad(k, 16) + pad(strong.byStrength[k] ?? 0, 14) + String(weak.byStrength[k] ?? 0));
  }
  out.push("");
  if (weak.weakExamples.length > 0) {
    out.push("Weak assertions the agent wrote in the weak arm");
    out.push("-".repeat(92));
    for (const e of weak.weakExamples) out.push(`  ${e}`);
    out.push("");
  } else {
    out.push("The agent wrote no assertion at or below EXISTENCE in the weak arm either.");
    out.push("");
  }

  process.stdout.write(out.join("\n") + "\n");
}

await main();
