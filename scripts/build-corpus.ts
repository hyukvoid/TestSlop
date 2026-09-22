/**
 * Materialises the corpus as real two-commit git repositories under work/corpus.
 *
 * Real repositories rather than in-memory strings, so that the evaluation
 * exercises the actual change collector: merge-base resolution, unified diff
 * line mapping, rename detection and file-role classification are all part of
 * what is being tested.
 *
 * Generated repositories live under work/ (gitignored) because they are fully
 * reproducible from the committed case definitions.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ALL_CASES } from "../corpus/cases/index.ts";
import type { CorpusCase } from "../corpus/types.ts";

const exec = promisify(execFile);

export const CORPUS_ROOT = path.resolve(import.meta.dirname, "..", "work", "corpus");

const GIT_IDENTITY = [
  "-c",
  "user.name=TestSlop Corpus",
  "-c",
  "user.email=corpus@testslop.local",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...GIT_IDENTITY, ...args], { cwd, windowsHide: true });
  return stdout;
}

async function writeTree(root: string, files: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (content === null) {
      await rm(abs, { force: true });
      continue;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

export async function buildCase(kase: CorpusCase, root = CORPUS_ROOT): Promise<string> {
  const repo = path.join(root, kase.id);
  await rm(repo, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });

  await git(repo, ["init", "-q", "-b", "main"]);

  // Scaffolding (package.json etc.) is committed with the base so that the
  // "change" commit contains only what the developer or agent actually touched.
  if (kase.scaffold) await writeTree(repo, kase.scaffold);
  await writeTree(repo, kase.base);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", `base: ${kase.id}`]);

  await writeTree(repo, kase.change);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", `change: ${kase.task}`]);

  return repo;
}

export async function buildAll(only?: string[]): Promise<Map<string, string>> {
  const selected = only?.length ? ALL_CASES.filter((c) => only.includes(c.id)) : ALL_CASES;
  const built = new Map<string, string>();
  for (const kase of selected) {
    const repo = await buildCase(kase);
    built.set(kase.id, repo);
  }
  return built;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const only = process.argv.slice(2);
  const built = await buildAll(only);
  process.stdout.write(`Built ${built.size} corpus repositories under ${CORPUS_ROOT}\n`);
  for (const [id, repo] of built) process.stdout.write(`  ${id}  ${repo}\n`);
}
