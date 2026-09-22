/**
 * Competitive comparison: run eslint-plugin-jest over the same corpus fixtures
 * and count how many TestSlop findings it also reports.
 *
 * The point is not to show that ESLint is bad. eslint-plugin-jest is excellent at
 * what it does. The point is to establish, with numbers rather than assertion,
 * which findings are *only* available with diff context — because if a linter
 * already reports them, TestSlop has no reason to exist.
 *
 * ESLint is run with the plugin's `all` config, i.e. every rule the plugin ships,
 * which is the most generous possible setting for the comparison.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { collectChangeSet } from "../src/core/changeset.ts";
import { analyse } from "../src/core/pipeline.ts";
import { listFilesAtRef } from "../src/core/git.ts";
import { ALL_CASES } from "../corpus/cases/index.ts";
import { buildCase } from "./build-corpus.ts";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

export interface LintFinding {
  file: string;
  line: number;
  ruleId: string | null;
  message: string;
  severity: number;
}

/**
 * `no-deprecated-functions` refuses to load unless the jest package itself is
 * resolvable, and its failure aborts the whole ESLint run. Excluded so that the
 * other ~50 rules can report. This mattered: the first version of this script
 * swallowed the resulting crash and confidently reported "ESLint: 0 findings",
 * which would have been a flattering and completely false comparison.
 */
const EXCLUDED_RULES = new Set(["no-deprecated-functions"]);

const FLAT_CONFIG = `import jest from "eslint-plugin-jest";

const excluded = new Set(${JSON.stringify([...EXCLUDED_RULES])});

export default [
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      parser: (await import("@typescript-eslint/parser")).default,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    plugins: { jest },
    rules: Object.fromEntries(
      Object.keys(jest.rules)
        .filter((name) => !excluded.has(name))
        .map((name) => ["jest/" + name, "warn"]),
    ),
  },
];
`;

/**
 * eslint-plugin-jest resolves `it`/`describe`/`expect` through their import
 * source. When they come from "vitest" it does not treat them as test functions,
 * so rules like `no-disabled-tests` stay silent — which would have made this
 * comparison flatter TestSlop for the wrong reason.
 *
 * To give the plugin its best possible showing, the vitest import is stripped
 * before linting so the fixtures read as jest-globals files. `vi.` references are
 * rewritten to `jest.` for the same reason.
 */
async function presentAsJestGlobals(repo: string, files: string[]): Promise<void> {
  for (const rel of files) {
    const abs = path.join(repo, rel);
    let src: string;
    try {
      src = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const rewritten = src
      .replace(/^\s*import\s*\{[^}]*\}\s*from\s*["']vitest["'];?\s*$/gm, "")
      .replace(/\bvi\./g, "jest.");
    if (rewritten !== src) await writeFile(abs, rewritten, "utf8");
  }
}

async function runEslint(repo: string): Promise<LintFinding[]> {
  const configPath = path.join(repo, "eslint.config.mjs");
  await writeFile(configPath, FLAT_CONFIG, "utf8");
  try {
    const { stdout } = await exec(
      "npx",
      [
        "eslint",
        "--no-config-lookup",
        "--config",
        configPath,
        "--format",
        "json",
        "--no-error-on-unmatched-pattern",
        ".",
      ],
      { cwd: repo, windowsHide: true, maxBuffer: 64 * 1024 * 1024, shell: true },
    );
    return parseEslintJson(stdout, repo);
  } catch (err) {
    // ESLint exits non-zero when it reports problems, and the JSON is still on
    // stdout in that case. A crash produces no JSON at all, and must be raised
    // rather than reported as "no findings".
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout && e.stdout.includes("[")) return parseEslintJson(e.stdout, repo);
    throw new Error(
      `eslint failed to produce a report for ${path.basename(repo)}: ${(e.stderr ?? e.message ?? "unknown").slice(0, 400)}`,
    );
  }
}

function parseEslintJson(stdout: string, repo: string): LintFinding[] {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  let parsed: Array<{ filePath: string; messages: Array<{ line: number; ruleId: string | null; message: string; severity: number }> }>;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  const out: LintFinding[] = [];
  for (const file of parsed) {
    const rel = path.relative(repo, file.filePath).split(path.sep).join("/");
    for (const m of file.messages) {
      if (!m.ruleId) continue;
      out.push({ file: rel, line: m.line, ruleId: m.ruleId, message: m.message, severity: m.severity });
    }
  }
  return out;
}

export interface ComparisonRow {
  id: string;
  category: string;
  testslopRules: string[];
  eslintRules: string[];
  findingCount: number;
  eslintCount: number;
  /** TestSlop findings whose file+line ESLint also reported. Co-location only. */
  overlapping: number;
  /** TestSlop findings ESLint said nothing about, by line. */
  unique: number;
}

async function main(): Promise<void> {
  // Install the comparison toolchain into a scratch directory, not the project.
  const lintDir = path.join(ROOT, "work", "lint-compare");
  await mkdir(lintDir, { recursive: true });
  await writeFile(
    path.join(lintDir, "package.json"),
    JSON.stringify({ name: "testslop-lint-compare", private: true, type: "module" }, null, 2),
    "utf8",
  );

  process.stderr.write("installing eslint + eslint-plugin-jest into work/lint-compare …\n");
  await exec(
    "npm",
    ["install", "--no-audit", "--no-fund", "--silent", "eslint@9.39.0", "eslint-plugin-jest@29.0.1", "@typescript-eslint/parser@8.46.0"],
    { cwd: lintDir, windowsHide: true, maxBuffer: 64 * 1024 * 1024, shell: true },
  );

  const rows: ComparisonRow[] = [];
  const cases = ALL_CASES.filter((c) => !Object.keys(c.change).some((p) => p.endsWith(".py")));

  for (const kase of cases) {
    const repo = await buildCase(kase);

    // Point the fixture at the installed toolchain by symlinking node_modules.
    const link = path.join(repo, "node_modules");
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(path.join(lintDir, "node_modules"), link, "junction");
    } catch {
      /* already linked */
    }

    const changeSet = await collectChangeSet({ cwd: repo, base: "HEAD~1" });
    const knownPaths = await listFilesAtRef(repo, "HEAD").catch(() => [] as string[]);
    const result = await analyse(changeSet, { knownPaths, python: false });

    // TestSlop has already been run above, so the fixtures can be rewritten in
    // place for ESLint's benefit without affecting the TestSlop numbers.
    const testFiles = changeSet.files.filter((f) => f.role === "test").map((f) => f.path);
    await presentAsJestGlobals(repo, testFiles);

    const lint = await runEslint(repo);
    const lintAtLine = new Set(lint.map((l) => `${l.file}:${l.line}`));
    const lintInFile = new Set(lint.map((l) => l.file));

    let overlapping = 0;
    for (const f of result.findings) {
      // Generous overlap definition: ESLint reported anything on the same line,
      // or anything at all in the same file for whole-file findings.
      if (lintAtLine.has(`${f.file}:${f.line}`) || (f.line === 1 && lintInFile.has(f.file))) {
        overlapping += 1;
      }
    }

    rows.push({
      id: kase.id,
      category: kase.category,
      testslopRules: [...new Set(result.findings.map((f) => f.ruleId))],
      eslintRules: [...new Set(lint.map((l) => l.ruleId!))],
      findingCount: result.findings.length,
      eslintCount: lint.length,
      overlapping,
      unique: result.findings.length - overlapping,
    });

    process.stderr.write(
      `${kase.id.padEnd(42)} testslop ${String(result.findings.length).padStart(2)}  eslint ${String(lint.length).padStart(3)}  overlap ${overlapping}\n`,
    );
  }

  // -------------------------------------------------------------------------
  // Report
  //
  // Line-collision is a useless overlap metric: with the `all` config the plugin
  // emits several formatting complaints per file, so almost any TestSlop finding
  // shares a line with something. What matters is whether any ESLint rule is
  // *about the same property of the code*, so overlap is scored against a curated
  // mapping instead.
  // -------------------------------------------------------------------------

  /** ESLint rules that address the same property as a given TestSlop rule. */
  const SEMANTIC_OVERLAP: Record<string, string[]> = {
    "test-disabled": ["jest/no-disabled-tests"],
    "test-removed": [],
    "exception-broadened": ["jest/require-to-throw-message"],
    "mock-only-test": ["jest/prefer-called-with"],
    "assertion-removed": ["jest/expect-expect"],
    "weak-new-test": ["jest/expect-expect"],
    "assertion-weakened": [],
    "expected-chasing-implementation": [],
    "self-derived-oracle": [],
    "snapshot-replaced-assertion": ["jest/no-large-snapshots"],
    "mock-scope-expanded": [],
    "test-only-production-path": [],
    "coverage-ignore-added": [],
    "changed-logic-survived": [],
  };

  const out: string[] = [""];
  out.push("Competitive comparison: eslint-plugin-jest (all rules) vs TestSlop");
  out.push("=".repeat(92));
  out.push("");
  out.push("Fixtures are presented to ESLint as jest-globals so that every rule can apply.");
  out.push("");
  out.push(
    "case".padEnd(44) + "TestSlop".padEnd(10) + "ESLint".padEnd(9) + "semantic overlap",
  );
  out.push("-".repeat(92));

  let tsTotal = 0;
  let esTotal = 0;
  let semanticTotal = 0;

  for (const r of rows) {
    const semantic = r.testslopRules.filter((rule) =>
      (SEMANTIC_OVERLAP[rule] ?? []).some((er) => r.eslintRules.includes(er)),
    );
    out.push(
      r.id.padEnd(44) +
        String(r.findingCount).padEnd(10) +
        String(r.eslintCount).padEnd(9) +
        (semantic.length ? semantic.join(", ") : "-"),
    );
    tsTotal += r.findingCount;
    esTotal += r.eslintCount;
    semanticTotal += semantic.length;
  }

  out.push("-".repeat(92));
  out.push("TOTAL".padEnd(44) + String(tsTotal).padEnd(10) + String(esTotal).padEnd(9) + String(semanticTotal));
  out.push("");

  const allEslintRules = new Set<string>();
  for (const r of rows) for (const x of r.eslintRules) allEslintRules.add(x);
  out.push(`Distinct eslint-plugin-jest rules that fired anywhere in the corpus: ${allEslintRules.size}`);
  out.push("  " + [...allEslintRules].sort().join("\n  "));
  out.push("");

  // Signal-to-noise on the clean half of the corpus is the decisive number.
  const clean = rows.filter((r) => r.category === "B");
  const dirty = rows.filter((r) => r.category === "A" || r.category === "D");
  const cleanTs = clean.reduce((n, r) => n + r.findingCount, 0);
  const cleanEs = clean.reduce((n, r) => n + r.eslintCount, 0);
  const dirtyTs = dirty.reduce((n, r) => n + r.findingCount, 0);
  const dirtyEs = dirty.reduce((n, r) => n + r.eslintCount, 0);

  out.push("Signal vs noise");
  out.push("-".repeat(92));
  out.push(`  On the ${dirty.length} degraded cases (A + D):  TestSlop ${dirtyTs} findings, ESLint ${dirtyEs}`);
  out.push(`  On the ${clean.length} clean cases (B):        TestSlop ${cleanTs} findings, ESLint ${cleanEs}`);
  out.push(
    `  ESLint fired on ${clean.filter((r) => r.eslintCount > 0).length}/${clean.length} clean cases; TestSlop fired on ${clean.filter((r) => r.findingCount > 0).length}/${clean.length}.`,
  );
  out.push("");
  out.push("Rules with no ESLint counterpart that fired anywhere in the corpus");
  out.push("-".repeat(92));
  const firedRules = new Set<string>();
  for (const r of rows) for (const x of r.testslopRules) firedRules.add(x);
  for (const rule of [...firedRules].sort()) {
    const counterparts = SEMANTIC_OVERLAP[rule] ?? [];
    const covered = counterparts.filter((er) => allEslintRules.has(er));
    if (covered.length === 0) out.push(`  ${rule}`);
  }
  out.push("");

  process.stdout.write(out.join("\n"));
  await writeFile(path.join(ROOT, "work", "lint-compare.json"), JSON.stringify(rows, null, 2), "utf8");
  process.stderr.write("\nWrote work/lint-compare.json\n");
}

await main();
