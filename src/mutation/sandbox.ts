/**
 * Sandboxed execution for behaviour verification.
 *
 * POC-01 mutated files in the user's working tree and restored them in a `finally`,
 * with a synchronous restore on SIGINT. That is recoverable but not defensible for a
 * public release: a hard kill, a power loss or a second process reading the file mid-run
 * all leave the developer with mutated source, and the developer has no way to know.
 *
 * POC-02 copies the working tree to a scratch directory and mutates only there. The
 * user's files are never written to. `node_modules` is linked rather than copied, which
 * is what makes this cheap enough to do per scan.
 *
 * Deliberately not a security sandbox. The test suite still runs with full privileges;
 * the goal is protecting the developer's source from the tool, not protecting the
 * machine from the test suite.
 */

import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface Sandbox {
  /** Root of the copied tree. */
  root: string;
  /** Remove the scratch directory. */
  dispose(): Promise<void>;
  /** Read a file from the sandbox. */
  read(rel: string): Promise<string>;
  /** Write a file inside the sandbox. */
  write(rel: string, content: string): Promise<void>;
}

/** Directories never worth copying, either because they are huge or regenerated. */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".vite",
  "work",
]);

export interface SandboxOptions {
  /**
   * Where to find the dependency tree to link, when it does not live at
   * `<repoRoot>/node_modules`.
   *
   * Added after a destructive harness bug. The external-history benchmark checked each
   * commit out into a git worktree and put a `node_modules` junction inside it so the
   * sandbox could find one. `git worktree remove --force` then deleted *through* that
   * junction and emptied the real repository's `node_modules` — verified directly: after
   * the call the link target's files were gone while the directory remained. Every
   * baseline after the first commit was red, and the harness reported that as a property
   * of the repository. Pointing the sandbox at the dependency tree removes the need to
   * ever place a link inside a directory something else will delete.
   */
  modulesFrom?: string;
  /**
   * Reuse a stable per-repository scratch directory so the test runner's transform
   * cache survives between verifications. Default true. Set false for isolation in
   * tests.
   */
  reuse?: boolean;
  /** Extra top-level entries to skip. */
  skip?: string[];
  /**
   * Link instead of copy. `node_modules` is always linked when present; listing more
   * here is for large fixture or asset directories.
   */
  link?: string[];
}

/**
 * A stable scratch path per repository, rather than a fresh mkdtemp per run.
 *
 * Measured: with a random path, vitest's transform cache (`node_modules/.vite`, keyed
 * by project root) is cold on every verification, and the baseline run went from 9 s
 * in-place to 26 s in the sandbox. A stable path means only the first verification of
 * a repository pays that, which is the right trade for a tool used repeatedly in a
 * dev loop.
 *
 * Source files are overwritten on every run, so a stale sandbox cannot produce a
 * stale result.
 */
function stableSandboxPath(repoRoot: string): string {
  const hash = createHash("sha1").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `testslop-${hash}`, path.basename(repoRoot) || "repo");
}

export async function createSandbox(repoRoot: string, opts: SandboxOptions = {}): Promise<Sandbox> {
  const reuse = opts.reuse ?? true;
  const base = reuse
    ? path.dirname(stableSandboxPath(repoRoot))
    : await mkdtemp(path.join(os.tmpdir(), "testslop-"));
  const root = reuse ? stableSandboxPath(repoRoot) : path.join(base, path.basename(repoRoot) || "repo");
  await mkdir(root, { recursive: true });

  const skip = new Set([...SKIP, ...(opts.skip ?? [])]);
  const { readdir } = await import("node:fs/promises");

  // Clear the previous source tree before copying, keeping only the linked dependency
  // directory.
  //
  // Copying with `force` overwrites files that exist in both revisions but leaves behind
  // files the new revision does not have. That produced a real, silent wrong answer: the
  // external-history harness reuses one worktree path for every commit it checks out, so
  // a stale test file from the previous commit stayed in the sandbox and kept killing
  // mutants. The same 18 commits reported 2 unverified behaviours on one run and 0 on the
  // next. A tool whose zero cannot be trusted is worse than no tool.
  if (reuse) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (entry.name === "node_modules") continue;
      await rm(path.join(root, entry.name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  for (const entry of await readdir(repoRoot, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(repoRoot, entry.name);
    const to = path.join(root, entry.name);
    await cp(from, to, { recursive: true, dereference: false, force: true }).catch(() => {
      /* unreadable entries are skipped rather than failing the scan */
    });
  }

  // Link the dependency tree. A copy of node_modules would dominate the runtime and
  // defeat the point of doing this per scan.
  const modules = opts.modulesFrom ?? path.join(repoRoot, "node_modules");
  const resolvedModules = existsSync(modules) ? await realpath(modules).catch(() => modules) : modules;
  if (existsSync(resolvedModules)) {
    // Resolve nested junctions first. A second junction to a worktree's node_modules
    // junction can fail silently on Windows, leaving the scratch sandbox without tests'
    // dependencies even though the analyzed repo itself can run them.
    await symlink(resolvedModules, path.join(root, "node_modules"), "junction").catch(async () => {
      // Some filesystems refuse junctions; fall back to a copy so verification still
      // works, and accept the cost.
      await cp(resolvedModules, path.join(root, "node_modules"), { recursive: true }).catch(() => {});
    });
  }

  for (const rel of opts.link ?? []) {
    const src = path.join(repoRoot, rel);
    if (!existsSync(src)) continue;
    await symlink(src, path.join(root, rel), "junction").catch(() => {});
  }

  return {
    root,
    async dispose() {
      // A reused sandbox is intentionally left in place: its value is the warm cache.
      // It lives under the OS temp directory and every source file is rewritten on the
      // next run, so it can never serve a stale result.
      if (!reuse) await rm(base, { recursive: true, force: true, maxRetries: 3 });
    },
    read(rel) {
      return readFile(path.join(root, rel), "utf8");
    },
    async write(rel, content) {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    },
  };
}
