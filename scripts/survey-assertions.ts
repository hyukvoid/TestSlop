/**
 * Measures which assertion APIs real JavaScript/TypeScript repositories use.
 *
 * POC-01 has to choose a second assertion ecosystem, and the brief is explicit
 * that the choice must be measured rather than assumed. This script walks the test
 * files of a set of shallow-cloned repositories and classifies every assertion
 * call site by API family, so the decision can be made on counts.
 *
 * Classification is intentionally syntactic and cheap. It does not need to be
 * perfect; it needs to be unbiased across families.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { classifyPath } from "../src/core/changeset.ts";

export type Family =
  | "jest-vitest-expect"
  | "chai-expect"
  | "chai-should"
  | "node-assert"
  | "ava-t"
  | "tape-t"
  | "uvu-assert"
  | "tap"
  | "jasmine-expect"
  | "unknown";

/**
 * Ordered detectors. The first family with a non-zero count for a file wins that
 * file's label, but *all* counts are accumulated so mixed files are visible.
 */
const DETECTORS: Array<{ family: Family; pattern: RegExp }> = [
  // chai's `expect(x).to.equal(y)` must be tested before the bare expect() form,
  // because it also matches `expect(`.
  { family: "chai-expect", pattern: /\bexpect\s*\([^)]*\)\s*(\.\s*(to|not|that|which)\b)/g },
  { family: "chai-should", pattern: /\)\s*\.should\s*\.|\b\w+\s*\.should\s*\.\s*(be|equal|have|not|eql)\b/g },
  { family: "jest-vitest-expect", pattern: /\bexpect\s*\([\s\S]{0,400}?\)\s*\.\s*(not\s*\.\s*|resolves\s*\.\s*|rejects\s*\.\s*)*to[A-Z]\w*\s*\(/g },
  { family: "ava-t", pattern: /\bt\s*\.\s*(is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|like|regex|snapshot|pass|fail)\s*\(/g },
  { family: "tape-t", pattern: /\bt\s*\.\s*(equal|notEqual|deepEqual|ok|notOk|error|end|plan|same)\s*\(/g },
  { family: "node-assert", pattern: /\bassert\s*(\.\s*(strictEqual|deepStrictEqual|equal|deepEqual|ok|throws|rejects|match|notStrictEqual|fail)\s*)?\(/g },
  { family: "uvu-assert", pattern: /\bassert\s*\.\s*(is|equal|type|instance|snapshot|throws|not)\s*\(/g },
  { family: "tap", pattern: /\b(t|tap)\s*\.\s*(match|has|hasStrict|type|rejects|resolves|test|teardown)\s*\(/g },
  { family: "jasmine-expect", pattern: /\bexpect\s*\([^)]*\)\s*\.\s*(toBe|toEqual)\s*\(/g },
];

const TEST_FILE = /\.(test|spec)\.(m?[jt]sx?|cjs)$/i;
const TEST_DIRISH = /(^|[\\/])(__tests__|tests?|spec|specs)([\\/]|$)/i;
const SOURCE_EXT = /\.(m?[jt]sx?|cjs)$/i;
const SKIP_DIR = /(^|[\\/])(node_modules|\.git|dist|build|coverage|fixtures?|__fixtures__|__snapshots__|examples?|benchmark|bench|docs?|website|\.next)([\\/]|$)/i;

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 10) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (SKIP_DIR.test(full)) continue;
    if (e.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
      yield full;
    }
  }
}

function looksLikeTest(rel: string): boolean {
  if (TEST_FILE.test(rel)) return true;
  // Files inside a tests directory with an ordinary name, e.g. immer's __tests__/base.js
  if (TEST_DIRISH.test(rel) && classifyPath(rel.split(path.sep).join("/")) === "test") return true;
  return false;
}

export interface RepoSurvey {
  repo: string;
  testFiles: number;
  /** Files labelled by their dominant family. */
  filesByFamily: Record<string, number>;
  /** Total assertion call sites per family. */
  callsByFamily: Record<string, number>;
  /** Test files where no known family matched. */
  unclassifiedFiles: string[];
}

export async function surveyRepo(repoDir: string): Promise<RepoSurvey> {
  const repo = path.basename(repoDir);
  const filesByFamily: Record<string, number> = {};
  const callsByFamily: Record<string, number> = {};
  const unclassifiedFiles: string[] = [];
  let testFiles = 0;

  for await (const file of walk(repoDir)) {
    const rel = path.relative(repoDir, file);
    if (!looksLikeTest(rel)) continue;

    let content: string;
    try {
      const s = await stat(file);
      if (s.size > 2 * 1024 * 1024) continue;
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    testFiles += 1;

    let best: Family | undefined;
    let bestCount = 0;
    for (const d of DETECTORS) {
      const matches = content.match(d.pattern);
      const n = matches?.length ?? 0;
      if (n === 0) continue;
      callsByFamily[d.family] = (callsByFamily[d.family] ?? 0) + n;
      if (n > bestCount) {
        bestCount = n;
        best = d.family;
      }
    }
    const label = best ?? "unknown";
    filesByFamily[label] = (filesByFamily[label] ?? 0) + 1;
    if (!best) unclassifiedFiles.push(rel);
  }

  return { repo, testFiles, filesByFamily, callsByFamily, unclassifiedFiles };
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, "..", "work", "survey");
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  const surveys: RepoSurvey[] = [];

  for (const d of dirs) {
    const s = await surveyRepo(path.join(root, d.name));
    surveys.push(s);
    process.stderr.write(`${pad(s.repo, 18)} ${pad(s.testFiles, 6)} files\n`);
  }

  const totalFiles: Record<string, number> = {};
  const totalCalls: Record<string, number> = {};
  let allFiles = 0;
  for (const s of surveys) {
    allFiles += s.testFiles;
    for (const [k, v] of Object.entries(s.filesByFamily)) totalFiles[k] = (totalFiles[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.callsByFamily)) totalCalls[k] = (totalCalls[k] ?? 0) + v;
  }

  const out: string[] = [""];
  const unknownFiles = totalFiles["unknown"] ?? 0;
  const withAssertions = allFiles - unknownFiles;

  out.push("Assertion API survey");
  out.push("=".repeat(88));
  out.push(`${dirs.length} repositories`);
  out.push(`${allFiles} files classified as tests by TestSlop's own path rules`);
  out.push(`${withAssertions} of those contain a recognisable assertion`);
  out.push("");
  out.push(
    `NOTE: the ${unknownFiles} files with no recognisable assertion are mostly not tests at all —`,
  );
  out.push(
    "they are entity definitions, fixtures and helpers that happen to live under a test/",
  );
  out.push(
    "directory (typeorm alone contributes 1942). That is a finding about TestSlop's path",
  );
  out.push("classification, reported separately, not about assertion APIs. They are excluded");
  out.push("from the percentages below.");
  out.push("");
  out.push(pad("family", 22) + pad("files", 9) + pad("% files", 10) + pad("call sites", 12) + "% calls");
  out.push("-".repeat(88));

  const allCalls = Object.values(totalCalls).reduce((a, b) => a + b, 0);
  const rows = Object.entries(totalFiles)
    .filter(([f]) => f !== "unknown")
    .sort((a, b) => b[1] - a[1]);
  for (const [family, files] of rows) {
    const calls = totalCalls[family] ?? 0;
    out.push(
      pad(family, 22) +
        pad(files, 9) +
        pad(`${((files / withAssertions) * 100).toFixed(1)}%`, 10) +
        pad(calls, 12) +
        `${allCalls ? ((calls / allCalls) * 100).toFixed(1) : "0"}%`,
    );
  }
  out.push("");

  // The decision this survey exists to make.
  const chaiFiles = (totalFiles["chai-expect"] ?? 0) + (totalFiles["chai-should"] ?? 0);
  const chaiCalls = (totalCalls["chai-expect"] ?? 0) + (totalCalls["chai-should"] ?? 0);
  const supported = totalFiles["jest-vitest-expect"] ?? 0;
  const supportedCalls = totalCalls["jest-vitest-expect"] ?? 0;
  out.push("Coverage decision");
  out.push("-".repeat(88));
  out.push(
    `  currently supported (jest/vitest expect)  ${((supported / withAssertions) * 100).toFixed(1)}% of files, ${((supportedCalls / allCalls) * 100).toFixed(1)}% of call sites`,
  );
  out.push(
    `  + chai (expect().to + should)             ${(((supported + chaiFiles) / withAssertions) * 100).toFixed(1)}% of files, ${(((supportedCalls + chaiCalls) / allCalls) * 100).toFixed(1)}% of call sites`,
  );
  const nodeAssertFiles = totalFiles["node-assert"] ?? 0;
  const nodeAssertCalls = totalCalls["node-assert"] ?? 0;
  out.push(
    `  + node:assert as well                     ${(((supported + chaiFiles + nodeAssertFiles) / withAssertions) * 100).toFixed(1)}% of files, ${(((supportedCalls + chaiCalls + nodeAssertCalls) / allCalls) * 100).toFixed(1)}% of call sites`,
  );
  out.push(
    `  ava, for comparison                       ${(((totalFiles["ava-t"] ?? 0) / withAssertions) * 100).toFixed(1)}% of files, ${(((totalCalls["ava-t"] ?? 0) / allCalls) * 100).toFixed(1)}% of call sites`,
  );
  out.push("");
  out.push("Per repository, dominant family by file count");
  out.push("-".repeat(88));
  for (const s of surveys.sort((a, b) => b.testFiles - a.testFiles)) {
    const dominant = Object.entries(s.filesByFamily).sort((a, b) => b[1] - a[1])[0];
    out.push(
      `  ${pad(s.repo, 18)} ${pad(s.testFiles, 6)} ${dominant ? `${dominant[0]} (${dominant[1]})` : "-"}`,
    );
  }
  out.push("");

  process.stdout.write(out.join("\n") + "\n");
  await writeFile(
    path.resolve(import.meta.dirname, "..", "work", "survey-assertions.json"),
    JSON.stringify({ surveys, totalFiles, totalCalls, allFiles }, null, 2),
    "utf8",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
