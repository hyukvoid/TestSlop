/**
 * Single-commit verification probe.
 *
 * Exists because an external finding on `bytes` looked wrong: the commit's own added
 * tests kill the alternative when run by hand, yet verification reported it as
 * unverified. This reproduces one commit with full progress output and dumps the exact
 * mutated source and runner output, so the disagreement can be located rather than
 * guessed at.
 *
 * Usage:
 *   node --experimental-strip-types scripts/probe-one.ts work/ext/bytes 6ec88d86a --test-command "npx mocha --reporter dot"
 */

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { collectChangeSet } from "../src/core/changeset.ts";
import { verifyChangedBehaviour } from "../src/mutation/behaviour-verify.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

async function main(): Promise<void> {
  const repo = path.resolve(process.argv[2]!);
  const sha = process.argv[3]!;
  const idx = process.argv.indexOf("--test-command");
  const testCommand = idx >= 0 ? process.argv[idx + 1] : undefined;

  const scratch = path.join(ROOT, "work", "probeone");
  await exec("git", ["worktree", "remove", "--force", scratch], { cwd: repo }).catch(() => {});
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(path.dirname(scratch), { recursive: true });
  await exec("git", ["worktree", "add", "--detach", "--force", scratch, sha], { cwd: repo });

  // See external-history.ts: no junction inside a git worktree.
  const modules = path.join(repo, "node_modules");

  const changeSet = await collectChangeSet({
    cwd: scratch,
    base: `${sha}^`,
    head: sha,
    useMergeBase: false,
  });
  process.stdout.write(`changed files:\n`);
  for (const f of changeSet.files) {
    process.stdout.write(`  ${f.role.padEnd(11)} ${f.path}  added lines ${f.addedLines.join(",")}\n`);
  }

  const report = await verifyChangedBehaviour(changeSet, {
    budget: 20,
    timeoutMs: 300_000,
    ...(existsSync(modules) ? { modulesFrom: modules } : {}),
    ...(testCommand ? { testCommand } : {}),
    onProgress: (m) => process.stdout.write(`  . ${m}\n`),
  });

  process.stdout.write(`\ntest command: ${report.testCommand}\n`);
  process.stdout.write(`baseline: ${report.baseline.ok} ${report.baseline.detail}\n`);
  for (const r of report.results) {
    process.stdout.write(
      `  ${r.outcome.padEnd(16)} ${r.alternative.file}:${r.alternative.line} ` +
        `${r.alternative.original} -> ${r.alternative.replacement}  ` +
        `[${r.alternative.distinguishing.description}]  tested with: ${r.testedWith.join(", ") || "(none)"}\n`,
    );
  }
  await exec("git", ["worktree", "remove", "--force", scratch], { cwd: repo }).catch(() => {});
}

await main();
