/**
 * E26 feedback-loop experiment on the X06 ms=0 survivor.
 * Clones the public task baseline, restores the original agent diff, then gives the
 * model the finding and records its response plus a fresh verifier result.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { externalTaskById } from "../corpus/external-tasks/index.ts";
import { collectChangeSet } from "../src/core/changeset.ts";
import { verifyChangedBehaviour } from "../src/mutation/behaviour-verify.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const TASK_ID = "X06-ms-negative-long";
const MODEL = "gpt-6-sol";
const TASK_REPO = path.join(ROOT, "work", "extbench", TASK_ID);
const UPSTREAM_DEPS = path.join(ROOT, "work", "ext", "ms", "node_modules");
const RAW_INPUT = path.join(ROOT, "work", "extbench-results-codex", MODEL, TASK_ID + ".json");
const FEEDBACK_REPO = path.join(ROOT, "work", "feedback", "E26-X06-ms-negative-long");
const FEEDBACK_RESULTS = path.join(ROOT, "work", "feedback-results");

interface RawRun {
  sourceCommit: string;
  diff: string;
  changedFiles: string[];
  outcome: string;
  agent: { name: string; model: string };
}

interface CommandResult {
  code: number | null;
  out: string;
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: process.platform === "win32" && command !== "codex" && !command.endsWith(".exe"),
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
    child.stdout?.on("data", (data: Buffer) => chunks.push(data.toString()));
    child.stderr?.on("data", (data: Buffer) => chunks.push(data.toString()));
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: chunks.join("") });
    };
    child.on("close", finish);
    child.on("error", () => finish(1));
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  return result.stdout;
}

const task = externalTaskById(TASK_ID);
if (!task) throw new Error("registered task is missing: " + TASK_ID);
if (existsSync(FEEDBACK_REPO)) throw new Error("feedback repo already exists: " + FEEDBACK_REPO);

const raw = JSON.parse(await readFile(RAW_INPUT, "utf8")) as RawRun;
if (raw.outcome !== "completed") throw new Error("X06 did not complete");
const sourceCommit = (await git(path.join(ROOT, "work", "ext", task.repo), ["rev-parse", "HEAD"])).trim();
if (sourceCommit !== raw.sourceCommit) throw new Error("upstream source commit changed since E23");

await mkdir(path.dirname(FEEDBACK_REPO), { recursive: true });
const clone = await run("git", ["clone", "--local", "--no-hardlinks", TASK_REPO, FEEDBACK_REPO], ROOT, 60_000);
if (clone.code !== 0) throw new Error("could not clone feedback repository: " + clone.out);

for (const relativePath of raw.changedFiles) {
  const from = path.join(TASK_REPO, ...relativePath.split("/"));
  const to = path.join(FEEDBACK_REPO, ...relativePath.split("/"));
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { force: true });
}

const modules = await realpath(UPSTREAM_DEPS);
await symlink(modules, path.join(FEEDBACK_REPO, "node_modules"), "junction");
const originalDiff = await git(FEEDBACK_REPO, ["diff", "HEAD", "--no-color"]);
if (originalDiff !== raw.diff) throw new Error("feedback clone does not reproduce the original X06 diff");

const prompt = [
  "A TestSlop review of the current change reported this possible missing behavior:",
  "",
  "File: src/index.ts, line 238",
  "Alternative: ms < 0 to ms <= 0",
  "Distinguishing input: ms = 0",
  "Context: the private round(ms, n) helper uses the condition to choose the sign.",
  "",
  "Please inspect the helper's callers and public behavior. If ms=0 can reach this condition and change an observable result, add a focused regression test that catches the alternative. If it cannot happen through the public API or is behaviorally equivalent, explain why without forcing an unreachable test or changing runtime behavior. Keep the existing change and its tests intact. Run the repository test suite after any edit.",
].join("\n");

const agentVersion = (await run("codex", ["--version"], FEEDBACK_REPO, 60_000)).out.trim();
const started = Date.now();
const agent = await run(
  "codex",
  [
    "exec",
    "-C", FEEDBACK_REPO,
    "-s", "danger-full-access",
    "--skip-git-repo-check",
    "-c", "mcp_servers={}",
    "-m", MODEL,
    prompt,
  ],
  FEEDBACK_REPO,
  1_200_000,
);
const agentDurationMs = Date.now() - started;

const untracked = (await git(FEEDBACK_REPO, ["ls-files", "--others", "--exclude-standard"]))
  .split("\n")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .filter((entry) => !/^(node_modules|coverage|\.nyc_output|es|lib|dist)\//.test(entry));
if (untracked.length > 0) {
  await git(FEEDBACK_REPO, ["add", "-A", "--", ...untracked]);
}

const finalDiff = await git(FEEDBACK_REPO, ["diff", "HEAD", "--no-color"]);
const testRun = await run("npx", ["jest", "--ci", "--silent"], FEEDBACK_REPO, 600_000);
const testsPass = testRun.code === 0;
const changeSet = await collectChangeSet({
  cwd: FEEDBACK_REPO,
  base: "HEAD",
  staged: untracked.length > 0,
});
const verification = testsPass && changeSet.files.some((file) => file.role === "production")
  ? await verifyChangedBehaviour(changeSet, {
      budget: 12,
      timeoutMs: 600_000,
      testCommand: "npx jest --ci --silent",
      onProgress: (message) => process.stderr.write("E26 verifier: " + message + "\n"),
    })
  : undefined;

await mkdir(FEEDBACK_RESULTS, { recursive: true });
const result = {
  experiment: "E26 feedback loop",
  taskId: TASK_ID,
  repo: task.repo,
  origin: task.origin,
  sourceCommit,
  model: MODEL,
  agentVersion,
  prompt,
  agentExitCode: agent.code,
  agentDurationMs,
  agentOutputTail: agent.out.slice(-12_000),
  originalDiffSha256: createHash("sha256").update(raw.diff).digest("hex"),
  originalDiffMatchesClone: true,
  feedbackDiff: finalDiff,
  changedFiles: changeSet.files.map((file) => file.path),
  testsPass,
  testExitCode: testRun.code,
  testOutputTail: testRun.out.slice(-4_000),
  ...(verification ? {
    verification: {
      baseline: verification.baseline,
      testCommand: verification.testCommand,
      counts: verification.counts,
      timing: verification.timing,
      results: verification.results,
    },
  } : {}),
};
await writeFile(path.join(FEEDBACK_RESULTS, "E26-X06.json"), JSON.stringify(result, null, 2), "utf8");
process.stderr.write("E26 saved; agent exit=" + agent.code + " tests=" + testsPass + "\n");
