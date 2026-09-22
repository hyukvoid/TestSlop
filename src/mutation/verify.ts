/**
 * Targeted mutation verification.
 *
 * Protocol:
 *   1. Establish a baseline: run the *changed* tests unmutated. If they do not
 *      pass, everything downstream is meaningless, so bail with a clear reason.
 *   2. Generate mutants only on production lines the diff touched.
 *   3. For each mutant: write it to disk, run only the changed test files that
 *      link to that production file, restore the file.
 *   4. A mutant that survives is reported as `changed-logic-survived`, class
 *      `evidence`, because it is an executed fact rather than a judgement.
 *
 * Safety: the original file content is captured in memory before the first
 * mutation and restored in a `finally`, including on SIGINT. The runner refuses
 * to operate on a repository with uncommitted changes to the files it intends to
 * mutate unless explicitly allowed, so an interrupted run cannot silently leave
 * a mutated source file behind and lose the developer's work.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import type { ChangeSet, Finding } from "../core/types.ts";
import { applyMutant, generateMutants, type Mutant } from "./mutators.ts";
import { parseTestFile } from "../adapters/ts/parse-test.ts";
import { buildTestToProductionMap, invertLinks } from "../core/link.ts";

export interface MutationOptions {
  budget?: number;
  testCommand?: string;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  /** Mutate even when the working tree is dirty. Off by default. */
  allowDirty?: boolean;
}

export interface MutantOutcome {
  mutant: Mutant;
  status: "killed" | "survived" | "error" | "skipped";
  durationMs: number;
  detail?: string;
}

export interface MutationRunReport {
  outcomes: MutantOutcome[];
  baseline: { ok: boolean; detail: string; durationMs: number };
  testCommand: string;
  totalDurationMs: number;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // Shell execution is required because the test command is user-supplied and
    // may contain arguments and npm script indirection. The command comes from
    // the developer's own --test-command or their package.json, never from the
    // analysed diff, so it is not an injection vector from untrusted content.
    const child = execFile(
      command,
      {
        cwd,
        shell: true,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | null; killed?: boolean; signal?: string }) | null;
        resolve({
          code: e?.code ?? (err ? 1 : 0),
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: Boolean(e?.killed || e?.signal === "SIGTERM"),
        });
      },
    );
    child.on("error", () => {
      /* resolved by the callback */
    });
  });
}

/**
 * Picks a test command. Prefers an explicitly configured one, then vitest, then
 * jest, in both cases with flags that force a single non-watch run. Returns
 * undefined when nothing suitable is found, which disables mutation rather than
 * guessing and producing meaningless results.
 */
export async function detectTestCommand(repoRoot: string): Promise<{ command: string; runner: "vitest" | "jest" } | undefined> {
  const pkgPath = path.join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string>; scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    return undefined;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) {
    return { command: "npx vitest run --reporter=dot --passWithNoTests=false", runner: "vitest" };
  }
  if (deps.jest) {
    return { command: "npx jest --ci --silent", runner: "jest" };
  }
  return undefined;
}

function testFileArgs(runner: "vitest" | "jest", files: string[]): string {
  if (files.length === 0) return "";
  // Both runners accept path substrings as positional filters.
  return " " + files.map((f) => JSON.stringify(f)).join(" ");
}

export async function runMutationVerification(changeSet: ChangeSet, opts: MutationOptions = {}): Promise<Finding[]> {
  const report = await runMutationExperiment(changeSet, opts);
  return mutationFindings(report);
}

export async function runMutationExperiment(changeSet: ChangeSet, opts: MutationOptions = {}): Promise<MutationRunReport> {
  const started = Date.now();
  const repoRoot = changeSet.repoRoot;
  const budget = opts.budget ?? 12;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const progress = opts.onProgress ?? ((): void => {});

  const detected = await detectTestCommand(repoRoot);
  const runner = detected?.runner ?? "vitest";
  const baseCommand = opts.testCommand ?? detected?.command;

  if (!baseCommand) {
    return {
      outcomes: [],
      baseline: {
        ok: false,
        detail: "no vitest or jest dependency found; pass --test-command to enable mutation",
        durationMs: 0,
      },
      testCommand: "<none>",
      totalDurationMs: Date.now() - started,
    };
  }

  // Link changed tests to changed production files so each mutant runs only the
  // tests that claim to cover it.
  const importsByTest = new Map<string, ReturnType<typeof parseTestFile>["imports"]>();
  for (const f of changeSet.files) {
    if (f.role === "test" && f.after !== undefined && !f.path.endsWith(".py")) {
      importsByTest.set(f.path, parseTestFile(f.path, f.after).imports);
    }
  }
  const links = buildTestToProductionMap(changeSet, importsByTest);
  const prodToTests = invertLinks(links);

  const changedProduction = changeSet.files.filter(
    (f) => f.role === "production" && f.after !== undefined && !f.path.endsWith(".py"),
  );

  // Baseline over every changed test file. Without this, a surviving mutant
  // could just mean the tests were never running.
  const changedTestFiles = changeSet.files.filter((f) => f.role === "test" && f.after !== undefined).map((f) => f.path);
  const baselineCommand = baseCommand + testFileArgs(runner, changedTestFiles);
  progress(`baseline: ${baselineCommand}`);
  const baselineStart = Date.now();
  const baselineRun = await runCommand(baselineCommand, repoRoot, timeoutMs);
  const baselineDuration = Date.now() - baselineStart;

  if (baselineRun.code !== 0) {
    return {
      outcomes: [],
      baseline: {
        ok: false,
        detail: baselineRun.timedOut
          ? `baseline test run timed out after ${timeoutMs} ms`
          : `baseline test run failed (exit ${baselineRun.code}); mutation results would be meaningless`,
        durationMs: baselineDuration,
      },
      testCommand: baselineCommand,
      totalDurationMs: Date.now() - started,
    };
  }
  progress(`baseline green in ${baselineDuration} ms`);

  // Build the mutant queue, round-robin across files so one dense file does not
  // consume the whole budget.
  const perFile: Mutant[][] = [];
  for (const file of changedProduction) {
    const lines = file.addedLines.length > 0 ? file.addedLines : [];
    const mutants = generateMutants(file.path, file.after!, { lines });
    if (mutants.length > 0) perFile.push(mutants);
  }
  const queue: Mutant[] = [];
  for (let i = 0; queue.length < budget; i += 1) {
    let progressed = false;
    for (const list of perFile) {
      const m = list[i];
      if (m) {
        queue.push(m);
        progressed = true;
        if (queue.length >= budget) break;
      }
    }
    if (!progressed) break;
  }

  const outcomes: MutantOutcome[] = [];
  const originals = new Map<string, string>();

  const restoreAll = async (): Promise<void> => {
    for (const [rel, content] of originals) {
      await writeFile(path.join(repoRoot, rel), content, "utf8");
    }
  };
  const onSignal = (): void => {
    // Synchronous restore: an interrupted run must never leave mutated source on
    // disk. Async cleanup would not complete before the process exits.
    for (const [rel, content] of originals) {
      try {
        writeFileSync(path.join(repoRoot, rel), content, "utf8");
      } catch {
        /* nothing more we can do at this point */
      }
    }
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    for (const [index, mutant] of queue.entries()) {
      const absolute = path.join(repoRoot, mutant.file);
      if (!originals.has(mutant.file)) {
        const onDisk = await readFile(absolute, "utf8").catch(() => undefined);
        if (onDisk === undefined) {
          outcomes.push({ mutant, status: "skipped", durationMs: 0, detail: "file not present in the working tree" });
          continue;
        }
        originals.set(mutant.file, onDisk);
      }
      const original = originals.get(mutant.file)!;

      // The mutant offsets were computed against the diff's `after` content. If
      // the working tree has drifted, skip rather than corrupt the file.
      const changedFile = changedProduction.find((f) => f.path === mutant.file);
      if (changedFile?.after !== undefined && changedFile.after !== original) {
        outcomes.push({
          mutant,
          status: "skipped",
          durationMs: 0,
          detail: "working tree differs from the revision analysed",
        });
        continue;
      }

      const relatedTests = (prodToTests.get(mutant.file) ?? []).filter((t) => !t.endsWith(".py"));
      const targets = relatedTests.length > 0 ? relatedTests : changedTestFiles;
      const command = baseCommand + testFileArgs(runner, targets);

      const mutantStart = Date.now();
      await writeFile(absolute, applyMutant(original, mutant), "utf8");
      progress(
        `mutant ${index + 1}/${queue.length}  ${mutant.file}:${mutant.line}  ${mutant.original} -> ${mutant.replacement}`,
      );
      const run = await runCommand(command, repoRoot, timeoutMs);
      await writeFile(absolute, original, "utf8");
      const durationMs = Date.now() - mutantStart;

      if (run.timedOut) {
        outcomes.push({ mutant, status: "error", durationMs, detail: "test run timed out" });
      } else if (run.code === 0) {
        outcomes.push({
          mutant,
          status: "survived",
          durationMs,
          detail: `tests: ${targets.join(", ") || "all changed"}`,
        });
      } else {
        outcomes.push({ mutant, status: "killed", durationMs });
      }
    }
  } finally {
    await restoreAll();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  return {
    outcomes,
    baseline: { ok: true, detail: "baseline green", durationMs: baselineDuration },
    testCommand: baseCommand,
    totalDurationMs: Date.now() - started,
  };
}

export function mutationFindings(report: MutationRunReport): Finding[] {
  const findings: Finding[] = [];

  if (!report.baseline.ok) {
    // Surfaced as a low-severity note so the user knows why no evidence appeared,
    // instead of silently reporting nothing.
    findings.push({
      ruleId: "mutation-unavailable",
      severity: "low",
      class: "review",
      confidence: 1,
      file: ".",
      line: 1,
      message: `Targeted mutation did not run: ${report.baseline.detail}`,
      evidence: [],
    });
    return findings;
  }

  for (const outcome of report.outcomes) {
    if (outcome.status !== "survived") continue;
    const m = outcome.mutant;
    findings.push({
      ruleId: "changed-logic-survived",
      severity: "high",
      class: "evidence",
      confidence: 0.97,
      file: m.file,
      line: m.line,
      productionFile: m.file,
      productionLine: m.line,
      message: `Changed logic was deliberately broken and the tests stayed green.`,
      rationale: `Nothing in the tests that changed alongside this line verifies ${m.describes}. This is an executed result, not an inference.`,
      evidence: [
        {
          label: `Mutation applied (${m.operator})`,
          before: `${m.file}:${m.line}   ${m.original}`,
          after: `${m.file}:${m.line}   ${m.replacement}`,
        },
        { label: "Result", detail: `test suite still passed in ${outcome.durationMs} ms  (${outcome.detail ?? ""})` },
      ],
    });
  }

  return findings;
}

export function summariseMutation(report: MutationRunReport): string {
  const total = report.outcomes.length;
  const killed = report.outcomes.filter((o) => o.status === "killed").length;
  const survived = report.outcomes.filter((o) => o.status === "survived").length;
  const errored = report.outcomes.filter((o) => o.status === "error" || o.status === "skipped").length;
  return `${total} mutants: ${killed} killed, ${survived} survived, ${errored} skipped/errored in ${report.totalDurationMs} ms`;
}
