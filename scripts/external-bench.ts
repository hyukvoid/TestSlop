/**
 * POC-02 external-repository agent benchmark.
 *
 * Same integrity rules as POC-01's harness: the agent is never told about TestSlop, the
 * diff is captured verbatim before analysis, every run is recorded including failures,
 * and no task is retried for a more interesting result.
 *
 * Difference from POC-01: the repository is real and the author did not write it, so the
 * harness has to tolerate a build step, a non-vitest runner, and a test command that
 * needs the project's own wiring.
 */

import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { EXTERNAL_TASKS, type ExternalTask } from "../corpus/external-tasks/index.ts";
import { collectChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import { listFilesAtRef } from "../src/core/git.ts";
import { verifyChangedBehaviour, type VerifyReport } from "../src/mutation/behaviour-verify.ts";
import type { Finding } from "../src/core/types.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCES = path.join(ROOT, "work", "ext");
const RUNS = path.join(ROOT, "work", "extbench");
const RESULTS = path.join(ROOT, "work", "extbench-results");

export type ExternalAgentKind = "codex" | "claude";

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

interface Run {
  code: number | null;
  out: string;
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const needsShell = process.platform === "win32" && command !== "codex" && !command.endsWith(".exe");
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: needsShell,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const chunks: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, out: chunks.join("") + "\n[timeout]" });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: chunks.join("") });
    };
    child.on("close", done);
    child.on("error", () => done(1));
  });
}

const RUNNER_COMMAND: Record<ExternalTask["runner"], { cmd: string; args: string[] }> = {
  mocha: { cmd: "npx", args: ["mocha", "--reporter", "dot"] },
  jest: { cmd: "npx", args: ["jest", "--ci", "--silent"] },
  vitest: { cmd: "npx", args: ["vitest", "run", "--reporter=dot"] },
};

export interface ExternalRunRecord {
  taskId: string;
  repo: string;
  sourceCommit: string;
  origin: string;
  runner: string;
  category: string;
  prior: string;
  priorReason: string;
  prompt: string;
  agent: { name: string; version: string; model: string };
  retryReason?: string;
  diff: string;
  changedFiles: string[];
  changedTestFiles: string[];
  changedProductionFiles: string[];
  testsPass: boolean;
  testSummary: string;
  agentExitCode: number | null;
  agentDurationMs: number;
  agentTail: string;
  staticFindings: Finding[];
  verification?: {
    baselineOk: boolean;
    baselineDetail: string;
    counts: VerifyReport["counts"];
    timing: VerifyReport["timing"];
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
  };
  outcome: "agent-failed" | "tests-red" | "completed-no-tests" | "completed";
  interventions: string[];
}

interface MaterialisedExternalTask {
  repo: string;
  sourceCommit: string;
}

async function materialise(task: ExternalTask): Promise<MaterialisedExternalTask> {
  const source = path.join(SOURCES, task.repo);
  if (!existsSync(source)) throw new Error(`source repository missing: ${source}`);

  const sourceCommit = (await git(source, ["rev-parse", "HEAD"])).trim();
  const repo = path.join(RUNS, task.id);
  await rm(repo, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(repo, { recursive: true });

  // Materialise tracked upstream files only. Ignore local artifacts and npm config so
  // the agent receives a clean, reproducible public source snapshot.
  const { symlink } = await import("node:fs/promises");
  const trackedFiles = (await git(source, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  for (const relativePath of trackedFiles) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized === ".npmrc" || normalized.endsWith("/.npmrc")) continue;
    const sourceFile = path.join(source, ...normalized.split("/"));
    const destinationFile = path.join(repo, ...normalized.split("/"));
    await mkdir(path.dirname(destinationFile), { recursive: true });
    await cp(sourceFile, destinationFile, { force: true });
  }
  const modules = path.join(source, "node_modules");
  if (existsSync(modules)) {
    await symlink(modules, path.join(repo, "node_modules"), "junction").catch(() => {});
  }

  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", `base: ${task.repo} @ ${sourceCommit.slice(0, 12)}`]);
  return { repo, sourceCommit };
}

const AGENT_TIMEOUT_MS = 1_200_000;

export async function runExternalTask(
  task: ExternalTask,
  opts: {
    agent?: ExternalAgentKind;
    model?: string;
    maxBudgetUsd?: number;
    retryReason?: string;
    onProgress?: (s: string) => void;
  } = {},
): Promise<ExternalRunRecord> {
  const progress = opts.onProgress ?? ((): void => {});
  const agentKind = opts.agent ?? "codex";
  const agentName = agentKind === "claude" ? "claude-code" : "codex-cli";
  const model = opts.model ?? (agentKind === "claude" ? "claude-sonnet-4-6" : "gpt-5.6-luna (config default)");
  const { repo, sourceCommit } = await materialise(task);
  const interventions: string[] = [];

  const command = agentKind === "claude" ? "claude.exe" : "codex";
  const agentArgs = agentKind === "claude"
    ? [
        "-p",
        "--model", model,
        "--permission-mode", "bypassPermissions",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config", JSON.stringify({ mcpServers: {} }),
        "--max-budget-usd", String(opts.maxBudgetUsd ?? 2),
        task.prompt,
      ]
    : [
        "exec",
        "-C", repo,
        "-s", "danger-full-access",
        "--skip-git-repo-check",
        "-c", "mcp_servers={}",
        ...(opts.model ? ["-m", opts.model] : []),
        task.prompt,
      ];

  progress(`${task.id}: running ${agentName} (${model}) in ${task.repo}`);
  const started = Date.now();
  const agent = await run(command, agentArgs, repo, AGENT_TIMEOUT_MS);
  const agentDurationMs = Date.now() - started;

  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard"]).catch(() => ""))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    // Build output and caches are not the agent's work.
    .filter((p) => !/^(node_modules|coverage|\.nyc_output|es|lib|dist)\//.test(p) && p !== "validator.js");
  if (untracked.length > 0) {
    await git(repo, ["add", "-A", "--", ...untracked]);
    interventions.push(`staged ${untracked.length} new file(s) so they appear in the diff`);
  }

  const runner = RUNNER_COMMAND[task.runner];
  const testRun = await run(runner.cmd, runner.args, repo, 600_000);
  const passMatch = /(\d+)\s+passing/.exec(testRun.out);
  const failMatch = /(\d+)\s+failing/.exec(testRun.out);
  const jestMatch = /Tests:\s+(.+)/.exec(testRun.out);
  const testSummary =
    jestMatch?.[1]?.trim() ??
    [passMatch ? `${passMatch[1]} passing` : undefined, failMatch ? `${failMatch[1]} failing` : undefined]
      .filter(Boolean)
      .join(", ") ??
    "no summary parsed";
  const testsPass = testRun.code === 0;

  let staticFindings: Finding[] = [];
  let changedFiles: string[] = [];
  let changedTestFiles: string[] = [];
  let changedProductionFiles: string[] = [];
  let verification: ExternalRunRecord["verification"];

  try {
    const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD", staged: untracked.length > 0 });
    const knownPaths = await listFilesAtRef(repo, "HEAD").catch(() => [] as string[]);
    const result = await analyse(changeSet, { knownPaths, python: false });
    staticFindings = result.findings;
    changedFiles = changeSet.files.map((f) => f.path);
    changedTestFiles = changeSet.files.filter((f) => f.role === "test").map((f) => f.path);
    changedProductionFiles = changeSet.files.filter((f) => f.role === "production").map((f) => f.path);

    if (testsPass && changedProductionFiles.length > 0) {
      const report = await verifyChangedBehaviour(changeSet, {
        budget: 12,
        timeoutMs: 600_000,
        testCommand: `${runner.cmd} ${runner.args.join(" ")}`,
        onProgress: (m) => progress(`    ${m}`),
      });
      verification = {
        baselineOk: report.baseline.ok,
        baselineDetail: report.baseline.detail,
        counts: report.counts,
        timing: report.timing,
        findings: report.results
          .filter((r) => r.outcome !== "caught")
          .map((r) => ({
            file: r.alternative.file,
            line: r.alternative.line,
            kind: r.alternative.kind,
            confidence: r.alternative.confidence,
            edit: `${r.alternative.original} -> ${r.alternative.replacement}`,
            context: r.alternative.context,
            distinguishing: r.alternative.distinguishing.description,
            ...(r.alternative.enclosing ? { enclosing: r.alternative.enclosing } : {}),
            outcome: r.outcome,
            testedWith: r.testedWith,
            ...(r.caughtBy ? { caughtBy: r.caughtBy } : {}),
          })),
      };
    }
  } catch (err) {
    interventions.push(`analysis failed: ${(err as Error).message}`);
  }

  const diff = await git(repo, ["diff", "HEAD", "--no-color"]).catch(() => "");

  let outcome: ExternalRunRecord["outcome"];
  if (diff.trim().length === 0) outcome = "agent-failed";
  else if (!testsPass) outcome = "tests-red";
  else if (changedTestFiles.length === 0) outcome = "completed-no-tests";
  else outcome = "completed";

  const version = (await run(command, ["--version"], repo, 60_000)).out.trim();

  const record: ExternalRunRecord = {
    taskId: task.id,
    repo: task.repo,
    sourceCommit,
    origin: task.origin,
    runner: task.runner,
    category: task.category,
    prior: task.prior,
    priorReason: task.priorReason,
    prompt: task.prompt,
    agent: { name: agentName, version, model },
    ...(opts.retryReason ? { retryReason: opts.retryReason } : {}),
    diff,
    changedFiles,
    changedTestFiles,
    changedProductionFiles,
    testsPass,
    testSummary,
    agentExitCode: agent.code,
    agentDurationMs,
    agentTail: agent.out.slice(-4000),
    staticFindings,
    ...(verification ? { verification } : {}),
    outcome,
    interventions,
  };

  const modelDir = model.replace(/[^a-zA-Z0-9.-]/g, "_");
  const resultsDir = agentKind === "claude"
    ? path.join(ROOT, "work", "extbench-results-claude", modelDir)
    : opts.model
      ? path.join(ROOT, "work", "extbench-results-codex", modelDir)
      : RESULTS;
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, `${task.id}.json`), JSON.stringify(record, null, 2), "utf8");

  progress(
    `${task.id}: ${outcome}  tests=${testsPass ? "green" : "RED"} (${testSummary})  ` +
      `static=${staticFindings.length}  unverified=${verification?.counts.unverified ?? "-"}  ` +
      `${Math.round(agentDurationMs / 1000)}s`,
  );
  return record;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agentIdx = args.indexOf("--agent");
  const agent = agentIdx >= 0 ? (args[agentIdx + 1] as ExternalAgentKind) : "codex";
  const modelIdx = args.indexOf("--model");
  const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
  const budgetIdx = args.indexOf("--max-budget-usd");
  const maxBudgetUsd = budgetIdx >= 0 ? Number(args[budgetIdx + 1]) : undefined;
  const retryIdx = args.indexOf("--retry-reason");
  const retryReason = retryIdx >= 0 ? args[retryIdx + 1] : undefined;
  if (agent !== "codex" && agent !== "claude") throw new Error(`unsupported agent: ${agent}`);
  if (maxBudgetUsd !== undefined && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)) {
    throw new Error("--max-budget-usd must be a positive number");
  }
  const only: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (["--agent", "--model", "--max-budget-usd", "--retry-reason"].includes(args[i]!)) {
      i += 1;
      continue;
    }
    if (!args[i]!.startsWith("--")) only.push(args[i]!);
  }
  const tasks = only.length ? EXTERNAL_TASKS.filter((t) => only.includes(t.id)) : EXTERNAL_TASKS;
  const modelDir = (model ?? (agent === "claude" ? "claude-sonnet-4-6" : "codex-default")).replace(/[^a-zA-Z0-9.-]/g, "_");
  const resultsDir = agent === "claude"
    ? path.join(ROOT, "work", "extbench-results-claude", modelDir)
    : model
      ? path.join(ROOT, "work", "extbench-results-codex", modelDir)
      : RESULTS;
  await mkdir(resultsDir, { recursive: true });

  for (const task of tasks) {
    try {
      await runExternalTask(task, {
        agent,
        ...(model ? { model } : {}),
        ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
        ...(retryReason ? { retryReason } : {}),
        onProgress: (s) => process.stderr.write(s + "\n"),
      });
    } catch (err) {
      process.stderr.write(`${task.id}: HARNESS ERROR ${(err as Error).message}\n`);
      await writeFile(
        path.join(resultsDir, `${task.id}.json`),
        JSON.stringify({ taskId: task.id, harnessError: (err as Error).message }, null, 2),
        "utf8",
      );
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
