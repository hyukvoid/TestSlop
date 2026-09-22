/**
 * Builds a `ChangeSet` from a git repository.
 *
 * Three comparison modes are supported because they map to the three moments a
 * developer actually wants to ask "what did the agent do to my tests?":
 *
 *   worktree  - agent just finished editing, nothing committed yet (default)
 *   staged    - about to commit
 *   committed - reviewing a branch or a PR
 */

import * as git from "./git.ts";
import type { ChangeSet, ChangedFile, FileRole, FileStatus } from "./types.ts";

const TEST_PATH = /(\.|_|\b)(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const TEST_DIR = /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)/i;
const PY_TEST_PATH = /(^|\/)(test_[^/]+\.py|[^/]+_test\.py)$/i;
const ANALYSABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;
const DECLARATION = /\.d\.ts$/i;
const FIXTURE_PATH = /(^|\/)(fixtures?|__mocks__|__fixtures__|snapshots?|__snapshots__)(\/|$)/i;

export function classifyPath(path: string): FileRole {
  if (!ANALYSABLE.test(path)) return "other";
  if (DECLARATION.test(path)) return "other";
  if (FIXTURE_PATH.test(path)) return "other";
  if (TEST_PATH.test(path) || PY_TEST_PATH.test(path)) return "test";

  // Jest's default convention puts tests in `__tests__/` with ordinary file
  // names. Requiring a `.test.` infix missed immer's entire suite (`__tests__/base.js`),
  // which showed up as zero analysable commits rather than as an error.
  // Helper modules inside those directories are still excluded, so that helper
  // churn does not inflate the changed-test count.
  if (TEST_DIR.test(path)) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const helperName = /^(setup|globals?|helpers?|utils?|util|fixtures?|mocks?|factories|support|jest\.|vitest\.|tsconfig|index)/i;
    // A helper can be identified either by its own name or by living in a
    // helper subdirectory, e.g. `test/helpers/server.js`.
    const helperDir = /(^|\/)(helpers?|utils?|fixtures?|mocks?|factories|support|common)\//i;
    const isHelper = helperName.test(base) || helperDir.test(path);
    return isHelper ? "other" : "test";
  }
  if (/\.(config|setup)\.(ts|js|mjs|cjs)$/i.test(path)) return "other";
  return "production";
}

function mapStatus(code: string): FileStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      return "modified";
  }
}

export interface CollectOptions {
  cwd: string;
  /** Base ref. Defaults to HEAD. */
  base?: string;
  /** Head ref. `null` means the working tree. */
  head?: string | null;
  /** Compare the index instead of the working tree. */
  staged?: boolean;
  /** When true, resolve `base` to the merge base with head. */
  useMergeBase?: boolean;
}

export async function collectChangeSet(opts: CollectOptions): Promise<ChangeSet> {
  const repoRoot = await git.repoRootOf(opts.cwd);
  if (!(await git.hasCommits(repoRoot))) {
    throw new git.GitError("repository has no commits to compare against");
  }

  const requestedBase = opts.base ?? "HEAD";
  const head = opts.head ?? null;

  // When comparing a branch, diff from the divergence point so that commits
  // landed on the base branch afterwards are not attributed to this change.
  let base = requestedBase;
  if (opts.useMergeBase !== false && requestedBase !== "HEAD") {
    base = await git.mergeBase(repoRoot, requestedBase, head ?? "HEAD");
  }

  const entries = await git.diffNameStatus(repoRoot, base, head, { staged: opts.staged });
  const files: ChangedFile[] = [];

  for (const entry of entries) {
    const role = classifyPath(entry.path);
    if (role === "other") continue;

    const status = mapStatus(entry.status);
    const beforePath = entry.oldPath ?? entry.path;

    const before = status === "added" ? undefined : await git.showFile(repoRoot, base, beforePath);
    const after =
      status === "deleted" ? undefined
      : head ? await git.showFile(repoRoot, head, entry.path)
      : opts.staged
        ? await git.showFile(repoRoot, ":0", entry.path).catch(() => undefined)
        : await git.readWorktreeFile(repoRoot, entry.path);

    const rawDiff = await git.diffForFile(repoRoot, base, head, entry.path, { staged: opts.staged });
    const { removed, added } = git.parseUnifiedDiffLines(rawDiff);

    const file: ChangedFile = {
      path: entry.path,
      status,
      role,
      removedLines: removed,
      addedLines: added,
    };
    if (entry.oldPath) file.oldPath = entry.oldPath;
    if (before !== undefined) file.before = before;
    if (after !== undefined) file.after = after;
    files.push(file);
  }

  const headLabel = head ?? (opts.staged ? "index" : "worktree");
  return {
    repoRoot,
    range: `${requestedBase}...${headLabel}`,
    baseRef: base,
    headRef: headLabel,
    files,
  };
}

/**
 * Builds a ChangeSet from in-memory content. Used by the analyzer's own tests so
 * that rule behaviour can be asserted without creating git repositories.
 */
export function syntheticChangeSet(
  entries: Array<{
    path: string;
    before?: string;
    after?: string;
    role?: FileRole;
  }>,
  range = "synthetic",
): ChangeSet {
  const files: ChangedFile[] = entries.map((e) => {
    const status: FileStatus =
      e.before === undefined ? "added" : e.after === undefined ? "deleted" : "modified";
    const beforeLines = e.before?.split(/\r?\n/) ?? [];
    const afterLines = e.after?.split(/\r?\n/) ?? [];
    // Without a real diff, treat every line that differs positionally as
    // touched. Rules that depend on precise hunks are tested against real repos.
    const removed: number[] = [];
    const added: number[] = [];
    const beforeSet = new Set(beforeLines.map((l) => l.trim()));
    const afterSet = new Set(afterLines.map((l) => l.trim()));
    beforeLines.forEach((l, i) => {
      if (l.trim() && !afterSet.has(l.trim())) removed.push(i + 1);
    });
    afterLines.forEach((l, i) => {
      if (l.trim() && !beforeSet.has(l.trim())) added.push(i + 1);
    });
    const file: ChangedFile = {
      path: e.path,
      status,
      role: e.role ?? classifyPath(e.path),
      removedLines: removed,
      addedLines: added,
    };
    if (e.before !== undefined) file.before = e.before;
    if (e.after !== undefined) file.after = e.after;
    return file;
  });

  return { repoRoot: "<synthetic>", range, baseRef: "base", headRef: "head", files };
}
