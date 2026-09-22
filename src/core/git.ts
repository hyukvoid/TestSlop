/**
 * Thin, deliberate wrapper over the `git` CLI.
 *
 * Shelling out rather than depending on a git library: TestSlop needs exactly
 * five operations (rev-parse, merge-base, diff --name-status, diff --unified,
 * show) and the CLI is the most stable, best-documented interface to them. A
 * library would add a dependency without removing any of the parsing work.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitError extends Error {}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(" ")} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

export async function repoRootOf(cwd: string): Promise<string> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return out.trim();
}

export async function revParse(repoRoot: string, ref: string): Promise<string> {
  return (await git(repoRoot, ["rev-parse", ref])).trim();
}

export async function hasCommits(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the merge base so that `--base main` compares against the point the
 * branch diverged, not against main's current tip. Without this, unrelated
 * commits landed on main after branching would show up as "changes".
 */
export async function mergeBase(repoRoot: string, a: string, b: string): Promise<string> {
  try {
    return (await git(repoRoot, ["merge-base", a, b])).trim();
  } catch {
    return (await revParse(repoRoot, a)).trim();
  }
}

export interface NameStatusEntry {
  status: "A" | "M" | "D" | "R" | "C" | "T";
  path: string;
  oldPath?: string;
}

export async function diffNameStatus(
  repoRoot: string,
  base: string,
  head: string | null,
  opts: { staged?: boolean } = {},
): Promise<NameStatusEntry[]> {
  const args = ["diff", "--name-status", "--find-renames", "--no-color"];
  if (opts.staged) args.push("--cached");
  args.push(base);
  if (head) args.push(head);
  const out = await git(repoRoot, args);
  const entries: NameStatusEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0] as NameStatusEntry["status"] | undefined;
    if (!code) continue;
    if (code === "R" || code === "C") {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath && newPath) entries.push({ status: code, path: newPath, oldPath });
    } else {
      const p = parts[1];
      if (p) entries.push({ status: code, path: p });
    }
  }
  return entries;
}

/** Returns file content at a revision, or undefined when it does not exist there. */
export async function showFile(repoRoot: string, ref: string, path: string): Promise<string | undefined> {
  try {
    return await git(repoRoot, ["show", `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

export interface HunkLines {
  removed: number[];
  added: number[];
}

/**
 * Parses unified diff hunk headers and bodies into the exact line numbers
 * touched on each side. Rules use this to scope themselves to what actually
 * changed rather than re-linting whole files.
 */
export function parseUnifiedDiffLines(diff: string): HunkLines {
  const removed: number[] = [];
  const added: number[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("+")) {
      added.push(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      removed.push(oldLine);
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { removed, added };
}

export async function diffForFile(
  repoRoot: string,
  base: string,
  head: string | null,
  path: string,
  opts: { staged?: boolean } = {},
): Promise<string> {
  const args = ["diff", "--unified=0", "--no-color", "--find-renames"];
  if (opts.staged) args.push("--cached");
  args.push(base);
  if (head) args.push(head);
  args.push("--", path);
  return git(repoRoot, args);
}

export async function readWorktreeFile(repoRoot: string, path: string): Promise<string | undefined> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return undefined;
  }
}

export async function currentBranch(repoRoot: string): Promise<string> {
  try {
    return (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    return "HEAD";
  }
}

/** Returns true when the working tree has no uncommitted modifications. */
export async function isClean(repoRoot: string): Promise<boolean> {
  const out = await git(repoRoot, ["status", "--porcelain"]);
  return out.trim().length === 0;
}

export async function listFilesAtRef(repoRoot: string, ref: string): Promise<string[]> {
  const out = await git(repoRoot, ["ls-tree", "-r", "--name-only", ref]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export const _internal = { git };
