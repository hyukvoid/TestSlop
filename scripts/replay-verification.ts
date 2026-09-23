/**
 * Replay behaviour verification on completed external-agent diffs without rerunning
 * the coding agent. Used to preserve model outputs while correcting verifier bugs.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { externalTaskById } from "../corpus/external-tasks/index.ts";
import { collectChangeSet } from "../src/core/changeset.ts";
import { verifyChangedBehaviour } from "../src/mutation/behaviour-verify.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const AGENT_RESULTS = path.join(ROOT, "work", "extbench-results-codex", "gpt-6-sol");
const REPLAY_RESULTS = path.join(ROOT, "work", "extbench-replays", "E25", "gpt-6-sol");

const RUNNER_COMMAND = {
  mocha: "npx mocha --reporter dot",
  jest: "npx jest --ci --silent",
  vitest: "npx vitest run --reporter=dot",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  return result.stdout;
}

const taskIds = process.argv.slice(2);
if (taskIds.length === 0) {
  throw new Error("pass one or more registered external task IDs");
}
await mkdir(REPLAY_RESULTS, { recursive: true });

for (const taskId of taskIds) {
  const task = externalTaskById(taskId);
  if (!task) throw new Error("unknown external task: " + taskId);

  const rawPath = path.join(AGENT_RESULTS, taskId + ".json");
  const raw = JSON.parse(await readFile(rawPath, "utf8")) as {
    sourceCommit: string;
    agent: { name: string; model: string };
    diff: string;
    outcome: string;
  };
  if (raw.outcome !== "completed") {
    throw new Error(taskId + " did not complete; replay is limited to completed diffs");
  }

  const sourceRoot = path.join(ROOT, "work", "ext", task.repo);
  const sourceCommit = (await git(sourceRoot, ["rev-parse", "HEAD"])).trim();
  if (sourceCommit !== raw.sourceCommit) {
    throw new Error(taskId + " source checkout does not match the recorded upstream commit");
  }

  const repo = path.join(ROOT, "work", "extbench", taskId);
  const diff = await git(repo, ["diff", "HEAD", "--no-color"]);
  if (diff !== raw.diff) {
    throw new Error(taskId + " worktree differs from the preserved raw agent diff");
  }

  const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const changeSet = await collectChangeSet({
    cwd: repo,
    base: "HEAD",
    staged: untracked.length > 0,
  });

  const verification = await verifyChangedBehaviour(changeSet, {
    budget: 12,
    timeoutMs: 600_000,
    testCommand: RUNNER_COMMAND[task.runner],
    onProgress: (message) => process.stderr.write(taskId + ": " + message + "\n"),
  });

  const replay = {
    experiment: "E25 nested dependency junction replay",
    taskId,
    repo: task.repo,
    origin: task.origin,
    sourceCommit,
    agent: raw.agent,
    rawRecord: path.relative(ROOT, rawPath).replaceAll("\\", "/"),
    diffSha256: createHash("sha256").update(diff).digest("hex"),
    diffMatchesRawRecord: true,
    verification,
  };
  const outPath = path.join(REPLAY_RESULTS, taskId + ".json");
  await writeFile(outPath, JSON.stringify(replay, null, 2), "utf8");
  process.stderr.write(
    taskId + ": replay saved; baseline=" + verification.baseline.ok +
      " generated=" + verification.counts.generated +
      " dedup=" + verification.counts.deduplicated +
      " executed=" + verification.counts.executed +
      " unverified=" + verification.counts.unverified + "\n",
  );
}
