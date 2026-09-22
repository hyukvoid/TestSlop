/**
 * POC-01 independent-agent benchmark harness.
 *
 * For each task:
 *   1. materialise `corpus/agent-base` into a fresh git repository
 *   2. apply any seed files (ci-red tasks need a genuinely failing suite)
 *   3. commit that as the base revision
 *   4. run the agent with the task prompt, unsupervised
 *   5. record the verbatim diff, the test result, and the TestSlop findings
 *
 * Integrity rules enforced by this script rather than by discipline:
 *   - the agent is never told about TestSlop, test quality, or assertions
 *   - the diff is captured before TestSlop runs and is never modified
 *   - every run is recorded, including failures and empty diffs
 *   - a task is never retried for a more interesting result; `--retry` exists only
 *     for infrastructure failure and stamps `retried: true` on the record
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_TASKS, type AgentTask } from "../corpus/agent-tasks/index.ts";
import { collectChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import { listFilesAtRef } from "../src/core/git.ts";
import type { Finding } from "../src/core/types.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Which base repository to materialise.
 *
 * `weak` is the style-contagion arm: identical production code, but the existing test
 * suite is written with existence checks instead of exact expectations. It exists to
 * separate "this agent writes strong assertions" from "this agent imitates the
 * repository it is working in".
 */
const BASES = {
  strong: path.join(ROOT, "corpus", "agent-base"),
  weak: path.join(ROOT, "corpus", "agent-base-weak"),
} as const;

export type BaseVariant = keyof typeof BASES;

const GIT_ID = [
  "-c", "user.name=Benchmark",
  "-c", "user.email=bench@testslop.local",
  "-c", "core.autocrlf=false",
  "-c", "commit.gpgsign=false",
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...GIT_ID, ...args], {
    cwd,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

export interface AgentRunRecord {
  taskId: string;
  /** Which base test-style variant this run used. */
  variant: BaseVariant;
  category: string;
  prior: string;
  priorReason: string;
  prompt: string;
  agent: { name: string; version: string; model: string };
  /** Verbatim unified diff of the agent's work. */
  diff: string;
  changedFiles: string[];
  changedTestFiles: string[];
  changedProductionFiles: string[];
  /** Did the agent leave the suite green? */
  testsPass: boolean;
  testSummary: string;
  agentExitCode: number | null;
  agentDurationMs: number;
  agentStdoutTail: string;
  findings: Finding[];
  /** True when the run was restarted because of infrastructure failure. */
  retried: boolean;
  /** Any manual intervention required to make the repo runnable. */
  interventions: string[];
  outcome:
    | "agent-failed"          // agent errored or produced no diff
    | "tests-red"             // agent finished but left the suite failing
    | "completed-no-tests"    // production changed, tests did not
    | "completed";            // agent finished, suite green
}

async function materialise(task: AgentTask, variant: BaseVariant): Promise<string> {
  const runs = variant === "weak" ? path.join(ROOT, "work", "agentbench-weak") : path.join(ROOT, "work", "agentbench");
  const repo = path.join(runs, task.id);
  await rm(repo, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });
  await cp(BASES[variant], repo, { recursive: true });

  // The base README describes the benchmark itself; remove it so the agent is not
  // told it is being measured.
  await rm(path.join(repo, "README.md"), { force: true });

  if (task.seed) {
    for (const [rel, content] of Object.entries(task.seed)) {
      const abs = path.join(repo, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
  }

  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base: order-service"]);
  return repo;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * stdin is explicitly closed rather than piped.
 *
 * `codex exec` appends piped stdin to the prompt, so an open-but-silent pipe makes
 * it print "Reading additional input from stdin..." and block until the timeout.
 * The first benchmark run burned 900 s on exactly this and recorded a false
 * `agent-failed`.
 */
function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // Shell only for `npx`, which is a .cmd shim on Windows. Running `codex`
    // through a shell mangles the prompt argument, which contains quotes and
    // apostrophes, and the agent then exits immediately with no work done.
    const needsShell = process.platform === "win32" && !command.endsWith(".exe") && command !== "codex";
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: needsShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out: string[] = [];
    const err: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ code: null, stdout: out.join(""), stderr: err.join("") + "\n[harness] timed out" });
      }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => err.push(d.toString()));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, stdout: out.join(""), stderr: err.join("") + String(e) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.join(""), stderr: err.join("") });
    });
  });
}

async function runTests(repo: string): Promise<{ pass: boolean; summary: string }> {
  const run = await runCommand("npx", ["vitest", "run", "--reporter=basic"], repo, 300_000);
  const text = run.stdout + run.stderr;
  const m = /Tests\s+(.+)$/m.exec(text);
  const files = /Test Files\s+(.+)$/m.exec(text);
  const summary = [files?.[1]?.trim(), m?.[1]?.trim()].filter(Boolean).join(" | ") || "no summary parsed";
  return { pass: run.code === 0, summary };
}

export interface BenchOptions {
  only?: string[];
  /** Which base repository to use. Defaults to the strong-style suite. */
  variant?: BaseVariant;
  model?: string;
  timeoutMs?: number;
  retry?: boolean;
  onProgress?: (line: string) => void;
}

const AGENT_TIMEOUT_MS = 900_000;

export async function runTask(task: AgentTask, opts: BenchOptions = {}): Promise<AgentRunRecord> {
  const progress = opts.onProgress ?? (() => {});
  const variant: BaseVariant = opts.variant ?? "strong";
  const repo = await materialise(task, variant);
  const interventions: string[] = [];

  const codexArgs = [
    "exec",
    "-C", repo,
    // `workspace-write` is the right policy but Codex's Windows sandbox helper
    // fails in this environment with `apply deny-read ACLs`, so the agent cannot
    // read or patch any file and every task records a false `agent-failed`.
    // Verified over a full 361 s run before switching. See docs/EVIDENCE-LOG.md E03.
    "-s", "danger-full-access",
    "--skip-git-repo-check",
    // MCP servers configured on this machine (shadcn, playwright, node_repl) add
    // startup latency and repeatedly fail, which pollutes the transcript and
    // wastes the agent's turns. The benchmark only needs file edits and a test
    // runner, so they are cleared for reproducibility.
    "-c", "mcp_servers={}",
  ];
  if (opts.model) codexArgs.push("-m", opts.model);
  codexArgs.push(task.prompt);

  progress(`${task.id}: running agent`);
  const started = Date.now();
  const agent = await runCommand("codex", codexArgs, repo, opts.timeoutMs ?? AGENT_TIMEOUT_MS);
  const agentDurationMs = Date.now() - started;

  // Capture the agent's work verbatim, before anything else touches the tree.
  const diff = await git(repo, ["diff", "HEAD", "--no-color"]).catch(() => "");
  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""))
    .split("\n").map((s) => s.trim()).filter(Boolean);

  // Stage new files so they appear in the changeset, then analyse against the
  // base commit. Staging is a read-only-equivalent operation for our purposes and
  // does not alter file contents.
  if (untracked.length > 0) {
    await git(repo, ["add", "-A"]);
    interventions.push(`staged ${untracked.length} untracked file(s) so they appear in the diff`);
  }

  const tests = await runTests(repo);

  let findings: Finding[] = [];
  let changedFiles: string[] = [];
  let changedTestFiles: string[] = [];
  let changedProductionFiles: string[] = [];
  try {
    const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD", staged: untracked.length > 0 });
    const knownPaths = await listFilesAtRef(repo, "HEAD").catch(() => [] as string[]);
    const result = await analyse(changeSet, { knownPaths, python: false });
    findings = result.findings;
    changedFiles = changeSet.files.map((f) => f.path);
    changedTestFiles = changeSet.files.filter((f) => f.role === "test").map((f) => f.path);
    changedProductionFiles = changeSet.files.filter((f) => f.role === "production").map((f) => f.path);
  } catch (err) {
    interventions.push(`testslop analysis failed: ${(err as Error).message}`);
  }

  const fullDiff = await git(repo, ["diff", "HEAD", "--no-color"]).catch(() => diff);

  let outcome: AgentRunRecord["outcome"];
  if (fullDiff.trim().length === 0) outcome = "agent-failed";
  else if (!tests.pass) outcome = "tests-red";
  else if (changedTestFiles.length === 0) outcome = "completed-no-tests";
  else outcome = "completed";

  const version = (await runCommand("codex", ["--version"], repo, 60_000)).stdout.trim();

  const record: AgentRunRecord = {
    taskId: task.id,
    variant,
    category: task.category,
    prior: task.prior,
    priorReason: task.priorReason,
    prompt: task.prompt,
    agent: { name: "codex-cli", version, model: opts.model ?? "gpt-5.6-luna (config default)" },
    diff: fullDiff,
    changedFiles,
    changedTestFiles,
    changedProductionFiles,
    testsPass: tests.pass,
    testSummary: tests.summary,
    agentExitCode: agent.code,
    agentDurationMs,
    agentStdoutTail: (agent.stdout + agent.stderr).slice(-4000),
    findings,
    retried: opts.retry ?? false,
    interventions,
    outcome,
  };

  const resultsDir = variant === "weak" ? path.join(ROOT, "work", "agentbench-results-weak") : path.join(ROOT, "work", "agentbench-results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, `${task.id}.json`), JSON.stringify(record, null, 2), "utf8");

  progress(
    `${task.id}: ${outcome}  tests=${tests.pass ? "green" : "RED"}  ` +
      `files=${changedFiles.length}  findings=${findings.length}  ${Math.round(agentDurationMs / 1000)}s`,
  );
  return record;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  const retry = args.includes("--retry");
  const skipExisting = args.includes("--skip-existing");
  const variant: BaseVariant = args.includes("--weak") ? "weak" : "strong";
  const RESULTS = variant === "weak" ? path.join(ROOT, "work", "agentbench-results-weak") : path.join(ROOT, "work", "agentbench-results");
  const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--model");

  const tasks = only.length ? AGENT_TASKS.filter((t) => only.includes(t.id)) : AGENT_TASKS;
  await mkdir(RESULTS, { recursive: true });

  for (const task of tasks) {
    const out = path.join(RESULTS, `${task.id}.json`);
    if (skipExisting && existsSync(out)) {
      process.stderr.write(`${task.id}: already recorded, skipping\n`);
      continue;
    }
    try {
      await runTask(task, {
        ...(model ? { model } : {}),
        variant,
        retry,
        onProgress: (l) => process.stderr.write(l + "\n"),
      });
    } catch (err) {
      process.stderr.write(`${task.id}: HARNESS ERROR ${(err as Error).message}\n`);
      await writeFile(
        out,
        JSON.stringify({ taskId: task.id, harnessError: (err as Error).message }, null, 2),
        "utf8",
      );
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
