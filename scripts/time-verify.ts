/**
 * Runtime measurement for changed-behaviour verification.
 *
 * Reports the breakdown POC-02 needs: sandbox setup, baseline, per-alternative
 * execution, and the linking-validation pass. Run twice against the same repository to
 * separate cold-cache cost from steady-state cost.
 *
 * Usage: node --experimental-strip-types scripts/time-verify.ts <repo> [runs]
 */

import path from "node:path";
import { collectChangeSet } from "../src/core/changeset.ts";
import { verifyChangedBehaviour, summariseVerification } from "../src/mutation/behaviour-verify.ts";

const repo = process.argv[2];
if (!repo) {
  process.stderr.write("usage: time-verify.ts <repo> [runs]\n");
  process.exit(2);
}
const runs = Number(process.argv[3] ?? 2);

const changeSet = await collectChangeSet({ cwd: path.resolve(repo), base: "HEAD" });

for (let i = 1; i <= runs; i += 1) {
  const report = await verifyChangedBehaviour(changeSet, { budget: 12 });
  const t = report.timing;
  process.stdout.write(
    `run ${i}  total ${(t.totalMs / 1000).toFixed(1)}s  ` +
      `sandbox ${(t.sandboxMs / 1000).toFixed(1)}s  ` +
      `baseline ${(t.baselineMs / 1000).toFixed(1)}s  ` +
      `execute ${(t.executionMs / 1000).toFixed(1)}s  ` +
      `linkcheck ${(t.fullSuiteMs / 1000).toFixed(1)}s\n`,
  );
  process.stdout.write(`        ${summariseVerification(report)}\n`);
}
