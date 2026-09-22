/**
 * Review aid for the false-negative study.
 *
 * Parses each agent-authored test file at head and prints the strength distribution
 * of the assertions the agent wrote, plus every assertion classified at or below
 * EXISTENCE. Those are the ones a manual reviewer needs to look at, because they are
 * where a weak oracle would hide.
 *
 * This is an aid to human judgement, not a substitute for it: the verdicts recorded
 * in corpus/agent-tasks/review.ts were assigned by reading the diffs.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseTestFile } from "../src/adapters/ts/parse-test.ts";
import { showFile } from "../src/core/git.ts";
import { strengthRank } from "../src/core/types.ts";
import type { AgentRunRecord } from "./agent-bench.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const RESULTS = path.join(ROOT, "work", "agentbench-results");
const RUNS = path.join(ROOT, "work", "agentbench");

const WEAK_AT_OR_BELOW = strengthRank("EXISTENCE");

async function main(): Promise<void> {
  const files = (await readdir(RESULTS)).filter((f) => f.endsWith(".json")).sort();
  const totals: Record<string, number> = {};
  let totalAssertions = 0;
  let totalCases = 0;

  for (const f of files) {
    const r = JSON.parse(await readFile(path.join(RESULTS, f), "utf8")) as AgentRunRecord;
    if (!r.changedTestFiles?.length) {
      process.stdout.write(`\n### ${r.taskId}\n   no test file changed\n`);
      continue;
    }

    process.stdout.write(`\n### ${r.taskId}   [prior: ${r.prior}]\n`);
    const repo = path.join(RUNS, r.taskId);

    for (const rel of r.changedTestFiles) {
      // Read the agent's version from the working tree via git's index-independent
      // path so the analysis matches what TestSlop saw.
      const content = await readFile(path.join(repo, rel), "utf8").catch(() => undefined);
      if (content === undefined) continue;
      const model = parseTestFile(rel, content);

      const byStrength: Record<string, number> = {};
      const weak: Array<{ test: string; raw: string; strength: string }> = [];
      let n = 0;
      for (const c of model.cases) {
        totalCases += 1;
        for (const a of c.assertions) {
          n += 1;
          byStrength[a.strength] = (byStrength[a.strength] ?? 0) + 1;
          totals[a.strength] = (totals[a.strength] ?? 0) + 1;
          if (strengthRank(a.strength) <= WEAK_AT_OR_BELOW) {
            weak.push({ test: c.name, raw: a.raw.slice(0, 92), strength: a.strength });
          }
        }
      }
      totalAssertions += n;

      process.stdout.write(
        `   ${rel}  ${model.cases.length} tests, ${n} assertions  ${JSON.stringify(byStrength)}\n`,
      );
      for (const w of weak) {
        process.stdout.write(`      WEAK ${w.strength.padEnd(10)} [${w.test.slice(0, 40)}] ${w.raw}\n`);
      }
    }
  }

  process.stdout.write("\n" + "=".repeat(96) + "\n");
  process.stdout.write(`Across all agent-authored test files at head: ${totalCases} tests, ${totalAssertions} assertions\n`);
  const ordered = Object.entries(totals).sort((a, b) => strengthRank(b[0] as never) - strengthRank(a[0] as never));
  for (const [k, v] of ordered) {
    process.stdout.write(`  ${k.padEnd(12)} ${String(v).padStart(5)}  ${((v / totalAssertions) * 100).toFixed(1)}%\n`);
  }
  const weakTotal = ordered
    .filter(([k]) => strengthRank(k as never) <= WEAK_AT_OR_BELOW)
    .reduce((n, [, v]) => n + v, 0);
  process.stdout.write(
    `\n  at or below EXISTENCE: ${weakTotal}/${totalAssertions} = ${((weakTotal / totalAssertions) * 100).toFixed(1)}%\n`,
  );
}

await main();
