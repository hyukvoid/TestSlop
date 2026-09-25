/**
 * External-repository validation of changed-behaviour verification, using real human
 * commits.
 *
 * This runner exercises the verifier on codebases the author did not write, using
 * real human commits rather than an independent-agent benchmark.
 *
 * This is the available substitute and it answers a narrower but still useful question:
 * on repositories nobody wrote for TestSlop, does verification find unverified changed
 * behaviour in real commits, and at what rate?
 *
 * It is not the agent question and is not presented as one.
 *
 * Method: find commits that changed both production and test files, check out the commit
 * into a scratch worktree, and verify `commit^..commit`. A red baseline is recorded
 * rather than hidden — how often verification is simply unavailable on real history is
 * itself a product finding.
 *
 * Usage:
 *   node --experimental-strip-types scripts/external-history.ts work/ext/bytes --limit 25
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { classifyPath, collectChangeSet } from "../src/core/changeset.ts";
import { verifyChangedBehaviour } from "../src/mutation/behaviour-verify.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

interface CommitResult {
  sha: string;
  subject: string;
  budget: number;
  baselineOk: boolean;
  baselineDetail: string;
  generated: number;
  afterDedup: number;
  executed: number;
  caught: number;
  unverified: number;
  caughtElsewhere: number;
  totalMs: number;
  findings: Array<{
    file: string;
    line: number;
    confidence: string;
    kind: string;
    edit: string;
    context: string;
    distinguishing: string;
  }>;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function candidates(repo: string, limit: number, window: number): Promise<Array<{ sha: string; subject: string }>> {
  const log = await git(repo, ["log", "--no-merges", `--max-count=${window}`, "--pretty=format:%H%x1f%s"]);
  const out: Array<{ sha: string; subject: string }> = [];
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    const [sha, subject] = line.split("\x1f");
    if (!sha) continue;
    let names: string;
    try {
      names = await git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    } catch {
      continue;
    }
    const roles = names.split("\n").map((s) => s.trim()).filter(Boolean).map(classifyPath);
    if (roles.includes("test") && roles.includes("production")) {
      out.push({ sha, subject: subject ?? "" });
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const repoArg = process.argv[2];
  if (!repoArg) {
    process.stderr.write("usage: external-history.ts <repo> [--limit n]\n");
    process.exit(2);
  }
  const repo = path.resolve(repoArg);
  const name = path.basename(repo);
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : 20;

  const testCmdIdx = process.argv.indexOf("--test-command");
  const testCommand = testCmdIdx >= 0 ? process.argv[testCmdIdx + 1] : undefined;
  const budgetIdx = process.argv.indexOf("--budget");
  const budget = budgetIdx >= 0 ? Number(process.argv[budgetIdx + 1]) : 10;
  if (!Number.isInteger(budget) || budget < 1) throw new Error("--budget must be a positive integer");

  const commits = await candidates(repo, limit, Math.max(limit * 20, 400));
  process.stderr.write(`${name}: ${commits.length} candidate commits\n`);

  const scratch = path.join(ROOT, "work", "exthist", name);
  const results: CommitResult[] = [];

  for (const [i, c] of commits.entries()) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    await mkdir(scratch, { recursive: true });

    // A detached worktree at the commit, with the installed dependency tree linked in.
    try {
      await git(repo, ["worktree", "add", "--detach", "--force", scratch, c.sha]);
    } catch (err) {
      process.stderr.write(`  ${c.sha.slice(0, 8)} worktree failed: ${(err as Error).message.slice(0, 80)}\n`);
      continue;
    }

    // Never place a node_modules junction inside this worktree. `git worktree remove
    // --force` deletes through a junction and emptied the real repository's
    // node_modules, which turned every later baseline red and was reported as a
    // property of the repository. The sandbox links the dependency tree directly
    // instead.
    const modules = path.join(repo, "node_modules");

    try {
      const changeSet = await collectChangeSet({
        cwd: scratch,
        base: `${c.sha}^`,
        head: c.sha,
        useMergeBase: false,
      });
      const report = await verifyChangedBehaviour(changeSet, {
        budget,
        timeoutMs: 300_000,
        ...(existsSync(modules) ? { modulesFrom: modules } : {}),
        ...(testCommand ? { testCommand } : {}),
      });

      results.push({
        sha: c.sha,
        subject: c.subject,
        budget,
        baselineOk: report.baseline.ok,
        baselineDetail: report.baseline.detail,
        generated: report.counts.generated,
        afterDedup: report.counts.deduplicated,
        executed: report.counts.executed,
        caught: report.counts.caught,
        unverified: report.counts.unverified,
        caughtElsewhere: report.counts.caughtElsewhere,
        totalMs: report.timing.totalMs,
        findings: report.results
          .filter((r) => r.outcome === "unverified")
          .map((r) => ({
            file: r.alternative.file,
            line: r.alternative.line,
            confidence: r.alternative.confidence,
            kind: r.alternative.kind,
            edit: `${r.alternative.original} -> ${r.alternative.replacement}`,
            context: r.alternative.context,
            distinguishing: r.alternative.distinguishing.description,
          })),
      });

      const last = results[results.length - 1]!;
      process.stderr.write(
        `  ${i + 1}/${commits.length} ${c.sha.slice(0, 8)} ` +
          (last.baselineOk
            ? `${last.executed} exec, ${last.unverified} unverified, ${Math.round(last.totalMs / 1000)}s`
            : `baseline unavailable: ${last.baselineDetail.slice(0, 60)}`) +
          `  | ${c.subject.slice(0, 44)}\n`,
      );
    } catch (err) {
      process.stderr.write(`  ${c.sha.slice(0, 8)} error: ${(err as Error).message.slice(0, 90)}\n`);
    } finally {
      await git(repo, ["worktree", "remove", "--force", scratch]).catch(() => {});
    }
  }

  await writeFile(
    path.join(ROOT, "work", `exthist-${name}.json`),
    JSON.stringify(results, null, 2),
    "utf8",
  );

  const usable = results.filter((r) => r.baselineOk);
  const out: string[] = [""];
  out.push(`External history verification — ${name}`);
  out.push("=".repeat(96));
  out.push(`  candidate commits            ${commits.length}`);
  out.push(`  analysed                     ${results.length}`);
  out.push(`  alternative budget/commit    ${budget}`);
  out.push(`  verification available       ${usable.length}`);
  out.push(`  baseline red / unavailable   ${results.length - usable.length}`);
  if (usable.length > 0) {
    const unver = usable.filter((r) => r.unverified > 0);
    out.push(`  commits with unverified beh. ${unver.length}  (${Math.round((unver.length / usable.length) * 100)}%)`);
    out.push(`  alternatives generated       ${usable.reduce((n, r) => n + r.generated, 0)}`);
    out.push(`  after dedup                  ${usable.reduce((n, r) => n + r.afterDedup, 0)}`);
    out.push(`  executed                     ${usable.reduce((n, r) => n + r.executed, 0)}`);
    out.push(`  unverified findings          ${usable.reduce((n, r) => n + r.unverified, 0)}`);
    out.push(`  mean wall time               ${(usable.reduce((n, r) => n + r.totalMs, 0) / usable.length / 1000).toFixed(1)}s`);
    out.push("");
    for (const r of usable.filter((x) => x.unverified > 0)) {
      out.push(`  ${r.sha.slice(0, 9)}  ${r.subject.slice(0, 70)}`);
      for (const f of r.findings) {
        out.push(`     [${f.confidence}] ${f.file}:${f.line}  ${f.edit}`);
        out.push(`         code: ${f.context.slice(0, 76)}`);
        out.push(`         unconstrained: ${f.distinguishing.slice(0, 76)}`);
      }
    }
  }
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
}

await main();
