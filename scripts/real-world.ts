/**
 * Category C: run the analyser over real commit history.
 *
 * This is the only part of the evaluation that is not author-controlled, and
 * therefore the only part that can honestly measure the false-positive rate.
 *
 * Method: find commits that touched at least one test file and at least one
 * production file (the situation TestSlop is designed for), then scan each one as
 * `commit^..commit`. These are merged, reviewed commits in mature repositories,
 * so the prior is that most of them are fine. A tool that fires on a large
 * fraction of them is producing noise regardless of how defensible each
 * individual finding sounds.
 *
 * Usage:
 *   node --experimental-strip-types scripts/real-world.ts work/real/redux --limit 150
 *   node --experimental-strip-types scripts/real-world.ts --all --limit 120 --json out.json
 */

import { execFile } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { collectChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import { listFilesAtRef } from "../src/core/git.ts";
import { classifyPath } from "../src/core/changeset.ts";
import type { Finding } from "../src/core/types.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export interface CommitScan {
  sha: string;
  subject: string;
  testFiles: number;
  productionFiles: number;
  findings: Finding[];
  durationMs: number;
}

export interface RepoReport {
  repo: string;
  head: string;
  commitsConsidered: number;
  commitsWithTestAndProdChanges: number;
  scanned: number;
  scans: CommitScan[];
  totals: {
    commitsWithFindings: number;
    findings: number;
    byRule: Record<string, number>;
    bySeverity: Record<string, number>;
    durationMsTotal: number;
    durationMsMedian: number;
  };
}

/**
 * Candidate commits: single-parent (merges conflate several changes and are not
 * what a developer reviews), touching both a test and a production file.
 */
async function candidateCommits(repo: string, limit: number, scanWindow: number): Promise<Array<{ sha: string; subject: string }>> {
  const log = await git(repo, [
    "log",
    "--no-merges",
    `--max-count=${scanWindow}`,
    "--pretty=format:%H%x1f%s",
  ]);

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
    const paths = names.split("\n").map((s) => s.trim()).filter(Boolean);
    const roles = paths.map(classifyPath);
    if (roles.includes("test") && roles.includes("production")) {
      out.push({ sha, subject: subject ?? "" });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface RealWorldOptions {
  limit?: number;
  /** How many commits deep to look for candidates. */
  scanWindow?: number;
  onProgress?: (line: string) => void;
}

export async function scanRepository(repo: string, opts: RealWorldOptions = {}): Promise<RepoReport> {
  const limit = opts.limit ?? 100;
  const scanWindow = opts.scanWindow ?? Math.max(limit * 12, 600);
  const progress = opts.onProgress ?? (() => {});
  const name = path.basename(repo);

  const head = (await git(repo, ["rev-parse", "--short", "HEAD"])).trim();
  const candidates = await candidateCommits(repo, limit, scanWindow);
  progress(`${name}: ${candidates.length} candidate commits (window ${scanWindow})`);

  const scans: CommitScan[] = [];
  for (const [i, c] of candidates.entries()) {
    try {
      const changeSet = await collectChangeSet({ cwd: repo, base: `${c.sha}^`, head: c.sha, useMergeBase: false });
      const knownPaths = await listFilesAtRef(repo, c.sha).catch(() => [] as string[]);
      const result = await analyse(changeSet, { knownPaths, python: false });
      scans.push({
        sha: c.sha,
        subject: c.subject,
        testFiles: result.summary.testFilesChanged,
        productionFiles: result.summary.productionFilesChanged,
        findings: result.findings,
        durationMs: result.summary.durationMs,
      });
      if (result.findings.length > 0) {
        progress(
          `  ${c.sha.slice(0, 8)}  ${result.findings.length} finding(s)  ${result.findings.map((f) => f.ruleId).join(",")}  | ${c.subject.slice(0, 60)}`,
        );
      }
    } catch (err) {
      progress(`  ${c.sha.slice(0, 8)}  skipped: ${(err as Error).message.slice(0, 120)}`);
    }
    if ((i + 1) % 25 === 0) progress(`  ...${i + 1}/${candidates.length}`);
  }

  const byRule: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let findings = 0;
  for (const s of scans) {
    for (const f of s.findings) {
      byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      findings += 1;
    }
  }
  const times = scans.map((s) => s.durationMs).sort((a, b) => a - b);

  return {
    repo: name,
    head,
    commitsConsidered: scanWindow,
    commitsWithTestAndProdChanges: candidates.length,
    scanned: scans.length,
    scans,
    totals: {
      commitsWithFindings: scans.filter((s) => s.findings.length > 0).length,
      findings,
      byRule,
      bySeverity,
      durationMsTotal: scans.reduce((n, s) => n + s.durationMs, 0),
      durationMsMedian: times.length ? times[Math.floor(times.length / 2)]! : 0,
    },
  };
}

export function renderRealWorld(reports: RepoReport[]): string {
  const out: string[] = [""];
  out.push("Category C - real repository history");
  out.push("=".repeat(78));
  out.push("");
  out.push(
    "repo".padEnd(12) +
      "commits".padEnd(9) +
      "w/ find".padEnd(9) +
      "rate".padEnd(8) +
      "findings".padEnd(10) +
      "median ms",
  );
  out.push("-".repeat(78));

  let totalScanned = 0;
  let totalWith = 0;
  let totalFindings = 0;
  const byRule: Record<string, number> = {};

  for (const r of reports) {
    const rate = r.scanned ? (r.totals.commitsWithFindings / r.scanned) * 100 : 0;
    out.push(
      r.repo.padEnd(12) +
        String(r.scanned).padEnd(9) +
        String(r.totals.commitsWithFindings).padEnd(9) +
        `${rate.toFixed(1)}%`.padEnd(8) +
        String(r.totals.findings).padEnd(10) +
        String(r.totals.durationMsMedian),
    );
    totalScanned += r.scanned;
    totalWith += r.totals.commitsWithFindings;
    totalFindings += r.totals.findings;
    for (const [k, v] of Object.entries(r.totals.byRule)) byRule[k] = (byRule[k] ?? 0) + v;
  }

  out.push("-".repeat(78));
  const rate = totalScanned ? (totalWith / totalScanned) * 100 : 0;
  out.push(
    "TOTAL".padEnd(12) +
      String(totalScanned).padEnd(9) +
      String(totalWith).padEnd(9) +
      `${rate.toFixed(1)}%`.padEnd(8) +
      String(totalFindings).padEnd(10),
  );
  out.push("");
  out.push("Findings by rule across all real commits");
  out.push("-".repeat(78));
  for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    out.push(`  ${String(v).padStart(4)}  ${k}`);
  }
  out.push("");
  return out.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 100;
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;

  let repos: string[];
  if (args.includes("--all")) {
    const root = path.resolve(import.meta.dirname, "..", "work", "real");
    const entries = await readdir(root, { withFileTypes: true });
    repos = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } else {
    repos = args
      .filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--limit" && args[i - 1] !== "--json")
      .map((p) => path.resolve(p));
  }

  const reports: RepoReport[] = [];
  for (const repo of repos) {
    reports.push(await scanRepository(repo, { limit, onProgress: (l) => process.stderr.write(l + "\n") }));
  }
  process.stdout.write(renderRealWorld(reports));
  if (jsonOut) {
    await writeFile(jsonOut, JSON.stringify(reports, null, 2), "utf8");
    process.stderr.write(`Wrote ${jsonOut}\n`);
  }
}
