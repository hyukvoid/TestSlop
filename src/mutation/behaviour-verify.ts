/**
 * Changed-behaviour verification.
 *
 * The POC-02 flagship. Protocol:
 *
 *   1. copy the working tree to a scratch sandbox; the user's files are never written
 *   2. baseline: run the linked changed tests unmutated. Red baseline -> stop and say so
 *   3. generate behavioural alternatives on changed production lines, deduplicated by
 *      distinguishing input
 *   4. for each: apply, run only the linked changed tests, restore
 *   5. for each survivor, run the **whole** suite once. If some other test kills it, the
 *      alternative is behaviourally real and the *linking* was too narrow — a different
 *      problem from "nothing verifies this", and one the report must distinguish
 *   6. report in developer language: what changed, what was tried, which input is
 *      unconstrained, which tests were expected to catch it
 *
 * Step 5 is new in POC-02 and does two jobs: it upgrades confidence on genuine findings
 * and it measures whether relevant-test selection is any good, which POC-01 never
 * checked.
 */

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ChangeSet, Finding } from "../core/types.ts";
import { generateAlternatives, applyAlternative, type BehaviouralAlternative, type Confidence } from "./behaviour.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { parseTestFile } from "../adapters/ts/parse-test.ts";
import { buildTestToProductionMap, invertLinks } from "../core/link.ts";

const exec = promisify(execFile);

export type Outcome =
  /** Some linked test failed. The behaviour is verified. */
  | "caught"
  /** Linked tests passed, and so did the whole suite. Nothing verifies this. */
  | "unverified"
  /** Linked tests passed but another test caught it: the linking was too narrow. */
  | "caught-elsewhere"
  /** Could not be evaluated. */
  | "skipped"
  | "error";

export interface AlternativeResult {
  alternative: BehaviouralAlternative;
  outcome: Outcome;
  durationMs: number;
  /** Test files the alternative was run against. */
  testedWith: string[];
  /** Populated for `caught-elsewhere`. */
  caughtBy?: string;
  detail?: string;
}

export interface VerifyReport {
  baseline: { ok: boolean; detail: string; durationMs: number };
  testCommand: string;
  results: AlternativeResult[];
  /** Alternatives suppressed before execution, with the reason. */
  suppressed: Array<{ alternative: BehaviouralAlternative; reason: string }>;
  timing: {
    sandboxMs: number;
    baselineMs: number;
    executionMs: number;
    fullSuiteMs: number;
    totalMs: number;
  };
  counts: {
    generated: number;
    deduplicated: number;
    executed: number;
    caught: number;
    unverified: number;
    caughtElsewhere: number;
  };
}

interface RunResult {
  code: number | null;
  out: string;
  timedOut: boolean;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    // Shell execution: the command comes from the developer's --test-command or their
    // package.json, never from the analysed diff, so it is not an injection vector from
    // untrusted content.
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const chunks: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, out: chunks.join(""), timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString()));
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: chunks.join(""), timedOut: false });
    };
    child.on("close", finish);
    child.on("error", () => finish(1));
  });
}

export type Runner = "vitest" | "jest" | "mocha" | "tape" | "ava" | "node";

/**
 * Runner detection.
 *
 * POC-02 widened this beyond vitest and jest after surveying ten external
 * repositories: only one used jest, four used mocha, two tape, one ava, one tap.
 *
 * Worth stating plainly, because it changes the product's reach: **behaviour
 * verification does not depend on assertion-API support**. It needs a diff and a way to
 * run tests. The assertion adapters matter for the static rules and for linking, not
 * here. So a repository whose assertions TestSlop cannot parse at all — ava, tape,
 * node:assert — can still be verified.
 */
export async function detectTestCommand(
  repoRoot: string,
): Promise<{ command: string; runner: Runner } | undefined> {
  const pkgPath = path.join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  } catch {
    return undefined;
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (deps.vitest) return { command: "npx vitest run --reporter=dot", runner: "vitest" };
  if (deps.jest) return { command: "npx jest --ci --silent", runner: "jest" };
  if (deps.mocha) return { command: "npx mocha --reporter dot", runner: "mocha" };
  if (deps.ava) return { command: "npx ava", runner: "ava" };
  if (deps.tape) return { command: "npx tape", runner: "tape" };
  if (pkg.scripts?.test?.includes("node --test")) return { command: "node --test", runner: "node" };
  return undefined;
}

/**
 * How each runner accepts a file filter.
 *
 * vitest and jest treat positionals as path substring patterns; mocha, tape, ava and
 * node:test take explicit paths. Getting this wrong silently runs the whole suite,
 * which would make every survivor meaningless — so an unsupported combination returns
 * undefined and the caller falls back to running everything, knowingly.
 */
function testArgs(files: string[], runner: Runner): string {
  if (files.length === 0) return "";
  const quoted = files.map((f) => JSON.stringify(f)).join(" ");
  switch (runner) {
    case "vitest":
    case "jest":
    case "mocha":
    case "tape":
    case "ava":
      return ` ${quoted}`;
    case "node":
      return ` ${quoted}`;
  }
}

/**
 * Which test file failed, parsed from runner output. Used to explain
 * `caught-elsewhere` rather than just reporting it.
 */
function failingTestFile(output: string): string | undefined {
  const m = /(?:FAIL|✗|×)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(output);
  if (m?.[1]) return m[1];
  const m2 = /(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*>/.exec(output);
  return m2?.[1];
}

export interface VerifyOptions {
  /** Maximum alternatives to execute. */
  budget?: number;
  testCommand?: string;
  timeoutMs?: number;
  /** Stop once this many unverified alternatives are found. */
  stopAfterFindings?: number;
  /** Run the full suite on survivors to validate linking. On by default. */
  validateLinking?: boolean;
  onProgress?: (message: string) => void;
}

const DEFAULTS = {
  // Evidence-led: POC-01 generated 93 mutants across 22 tasks, a median of 3 per task
  // and a maximum of 14. A budget of 12 covers the distribution while bounding the
  // worst case, and deduplication now removes roughly a fifth before execution.
  budget: 12,
  timeoutMs: 180_000,
  stopAfterFindings: 4,
  validateLinking: true,
};

export async function verifyChangedBehaviour(
  changeSet: ChangeSet,
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  const started = Date.now();
  const progress = opts.onProgress ?? ((): void => {});
  const budget = opts.budget ?? DEFAULTS.budget;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const stopAfter = opts.stopAfterFindings ?? DEFAULTS.stopAfterFindings;
  const validateLinking = opts.validateLinking ?? DEFAULTS.validateLinking;

  const empty = (detail: string): VerifyReport => ({
    baseline: { ok: false, detail, durationMs: 0 },
    testCommand: "<none>",
    results: [],
    suppressed: [],
    timing: { sandboxMs: 0, baselineMs: 0, executionMs: 0, fullSuiteMs: 0, totalMs: Date.now() - started },
    counts: { generated: 0, deduplicated: 0, executed: 0, caught: 0, unverified: 0, caughtElsewhere: 0 },
  });

  const detected = await detectTestCommand(changeSet.repoRoot);
  const baseCommand = opts.testCommand ?? detected?.command;
  const runner: Runner = detected?.runner ?? "vitest";
  if (!baseCommand) {
    return empty("no vitest or jest dependency found; pass --test-command to enable verification");
  }

  // Link changed tests to changed production files.
  const importsByTest = new Map<string, ReturnType<typeof parseTestFile>["imports"]>();
  for (const f of changeSet.files) {
    if (f.role === "test" && f.after !== undefined && !f.path.endsWith(".py")) {
      importsByTest.set(f.path, parseTestFile(f.path, f.after).imports);
    }
  }
  const links = buildTestToProductionMap(changeSet, importsByTest);
  const prodToTests = invertLinks(links);
  const changedTestFiles = changeSet.files
    .filter((f) => f.role === "test" && f.after !== undefined && !f.path.endsWith(".py"))
    .map((f) => f.path);

  const changedProduction = changeSet.files.filter(
    (f) => f.role === "production" && f.after !== undefined && !f.path.endsWith(".py"),
  );
  if (changedProduction.length === 0) {
    return empty("no changed production files to verify");
  }

  // ---- Generate before paying for a sandbox -------------------------------
  const perFile: BehaviouralAlternative[][] = [];
  let generatedRaw = 0;
  for (const file of changedProduction) {
    const all = generateAlternatives(file.path, file.after!, { lines: [] });
    generatedRaw += all.length;
    const scoped = generateAlternatives(file.path, file.after!, { lines: file.addedLines });
    if (scoped.length > 0) perFile.push(scoped);
  }

  // Round-robin so one dense file cannot consume the whole budget.
  const queue: BehaviouralAlternative[] = [];
  const suppressed: Array<{ alternative: BehaviouralAlternative; reason: string }> = [];
  for (let i = 0; ; i += 1) {
    let progressed = false;
    for (const list of perFile) {
      const a = list[i];
      if (!a) continue;
      progressed = true;
      if (queue.length < budget) queue.push(a);
      else suppressed.push({ alternative: a, reason: "over budget" });
    }
    if (!progressed) break;
  }
  const deduplicated = perFile.reduce((n, l) => n + l.length, 0);

  if (queue.length === 0) {
    return empty("no behavioural alternatives on the changed lines");
  }

  // ---- Sandbox -----------------------------------------------------------
  const sandboxStart = Date.now();
  let sandbox: Sandbox;
  try {
    sandbox = await createSandbox(changeSet.repoRoot);
  } catch (err) {
    return empty(`could not create a sandbox: ${(err as Error).message}`);
  }
  const sandboxMs = Date.now() - sandboxStart;
  progress(`sandbox ready in ${sandboxMs} ms`);

  try {
    // ---- Baseline --------------------------------------------------------
    const linkedFor = (file: string): string[] => {
      const linked = (prodToTests.get(file) ?? []).filter((t) => !t.endsWith(".py"));
      return linked.length > 0 ? linked : changedTestFiles;
    };

    const baselineTargets = changedTestFiles;
    const baselineCommand = baseCommand + testArgs(baselineTargets, runner);
    const baselineStart = Date.now();
    const baselineRun = await runCommand(baselineCommand, sandbox.root, timeoutMs);
    const baselineMs = Date.now() - baselineStart;

    if (baselineRun.code !== 0) {
      return {
        baseline: {
          ok: false,
          detail: baselineRun.timedOut
            ? `baseline timed out after ${timeoutMs} ms`
            : `baseline is red (exit ${baselineRun.code}); survivors would be meaningless`,
          durationMs: baselineMs,
        },
        testCommand: baselineCommand,
        results: [],
        suppressed,
        timing: { sandboxMs, baselineMs, executionMs: 0, fullSuiteMs: 0, totalMs: Date.now() - started },
        counts: { generated: generatedRaw, deduplicated, executed: 0, caught: 0, unverified: 0, caughtElsewhere: 0 },
      };
    }
    progress(`baseline green in ${baselineMs} ms`);

    // ---- Execute ---------------------------------------------------------
    const originals = new Map<string, string>();
    const results: AlternativeResult[] = [];
    const executionStart = Date.now();
    let unverifiedCount = 0;

    for (const [index, alt] of queue.entries()) {
      if (unverifiedCount >= stopAfter) {
        suppressed.push({ alternative: alt, reason: `stopped after ${stopAfter} findings` });
        continue;
      }

      if (!originals.has(alt.file)) {
        const content = await sandbox.read(alt.file).catch(() => undefined);
        if (content === undefined) {
          results.push({ alternative: alt, outcome: "skipped", durationMs: 0, testedWith: [], detail: "file missing in sandbox" });
          continue;
        }
        originals.set(alt.file, content);
      }
      const original = originals.get(alt.file)!;

      const targets = linkedFor(alt.file);
      const command = baseCommand + testArgs(targets, runner);
      const t0 = Date.now();

      await sandbox.write(alt.file, applyAlternative(original, alt));
      progress(
        `${index + 1}/${queue.length}  ${alt.file}:${alt.line}  ${alt.original} -> ${alt.replacement}  [${alt.distinguishing.description}]`,
      );
      const run = await runCommand(command, sandbox.root, timeoutMs);
      await sandbox.write(alt.file, original);
      const durationMs = Date.now() - t0;

      if (run.timedOut) {
        results.push({ alternative: alt, outcome: "error", durationMs, testedWith: targets, detail: "test run timed out" });
      } else if (run.code !== 0) {
        results.push({ alternative: alt, outcome: "caught", durationMs, testedWith: targets });
      } else {
        results.push({ alternative: alt, outcome: "unverified", durationMs, testedWith: targets });
        unverifiedCount += 1;
      }
    }
    const executionMs = Date.now() - executionStart;

    // ---- Linking validation ----------------------------------------------
    // For each unverified alternative, run the whole suite once. If a test elsewhere
    // kills it, the behaviour *is* verified and the finding would have been a false
    // alarm caused by too-narrow linking.
    let fullSuiteMs = 0;
    if (validateLinking) {
      const fullStart = Date.now();
      for (const r of results) {
        if (r.outcome !== "unverified") continue;
        const original = originals.get(r.alternative.file)!;
        await sandbox.write(r.alternative.file, applyAlternative(original, r.alternative));
        const run = await runCommand(baseCommand, sandbox.root, timeoutMs);
        await sandbox.write(r.alternative.file, original);
        if (!run.timedOut && run.code !== 0) {
          r.outcome = "caught-elsewhere";
          const where = failingTestFile(run.out);
          if (where) r.caughtBy = where;
          r.detail = `killed by the full suite but not by ${r.testedWith.join(", ") || "the linked tests"}`;
          unverifiedCount -= 1;
        }
      }
      fullSuiteMs = Date.now() - fullStart;
      if (fullSuiteMs > 0) progress(`linking validation ${fullSuiteMs} ms`);
    }

    return {
      baseline: { ok: true, detail: "baseline green", durationMs: baselineMs },
      testCommand: baseCommand,
      results,
      suppressed,
      timing: { sandboxMs, baselineMs, executionMs, fullSuiteMs, totalMs: Date.now() - started },
      counts: {
        generated: generatedRaw,
        deduplicated,
        executed: results.length,
        caught: results.filter((r) => r.outcome === "caught").length,
        unverified: results.filter((r) => r.outcome === "unverified").length,
        caughtElsewhere: results.filter((r) => r.outcome === "caught-elsewhere").length,
      },
    };
  } finally {
    await sandbox.dispose().catch(() => {});
  }
}

const SEVERITY_BY_CONFIDENCE: Record<Confidence, "high" | "medium" | "low"> = {
  high: "high",
  medium: "medium",
  low: "low",
};

/**
 * Converts verification results into findings.
 *
 * `unverified` becomes the finding. `caught-elsewhere` is reported separately and at
 * low severity, because it says something about TestSlop's linking rather than about
 * the developer's tests.
 */
export function behaviourFindings(report: VerifyReport): Finding[] {
  const findings: Finding[] = [];

  if (!report.baseline.ok) {
    findings.push({
      ruleId: "verification-unavailable",
      severity: "low",
      class: "review",
      confidence: 1,
      file: ".",
      line: 1,
      message: `Changed-behaviour verification did not run: ${report.baseline.detail}`,
      evidence: [],
    });
    return findings;
  }

  for (const r of report.results) {
    if (r.outcome === "unverified") {
      const a = r.alternative;
      findings.push({
        ruleId: "unverified-behaviour",
        severity: SEVERITY_BY_CONFIDENCE[a.confidence],
        class: "evidence",
        confidence: a.confidence === "high" ? 0.95 : a.confidence === "medium" ? 0.75 : 0.55,
        file: a.file,
        line: a.line,
        productionFile: a.file,
        productionLine: a.line,
        message: `Nothing verifies the behaviour at ${a.distinguishing.description}.`,
        rationale:
          `The changed code was altered so that it behaves differently for ${a.distinguishing.description}, ` +
          `and every linked test still passed. This is an executed result, not an inference.`,
        evidence: [
          { label: `Changed code${a.enclosing ? ` in \`${a.enclosing}\`` : ""}`, detail: a.context },
          { label: "TestSlop tried", before: a.original, after: a.replacement },
          { label: "Unconstrained input", detail: a.distinguishing.description },
          {
            label: "Tests run",
            detail: `${r.testedWith.join(", ") || "all changed tests"} — all passed${
              report.timing.fullSuiteMs > 0 ? ", and so did the rest of the suite" : ""
            }`,
          },
        ],
      });
    } else if (r.outcome === "caught-elsewhere") {
      const a = r.alternative;
      findings.push({
        ruleId: "verified-elsewhere",
        severity: "low",
        class: "review",
        confidence: 0.6,
        file: a.file,
        line: a.line,
        message: `Behaviour at ${a.distinguishing.description} is verified, but not by the tests that changed alongside it.`,
        rationale:
          "Caught by the wider suite only. The change is protected, but the tests added with it do not protect it, " +
          "so a future edit to those tests could remove the coverage silently.",
        evidence: [
          { label: "Changed code", detail: a.context },
          { label: "TestSlop tried", before: a.original, after: a.replacement },
          { label: "Linked tests that missed it", detail: r.testedWith.join(", ") || "none" },
          ...(r.caughtBy ? [{ label: "Caught by", detail: r.caughtBy }] : []),
        ],
      });
    }
  }

  return findings;
}

export function summariseVerification(report: VerifyReport): string {
  if (!report.baseline.ok) return `not run: ${report.baseline.detail}`;
  const c = report.counts;
  return (
    `${c.generated} alternatives generated, ${c.deduplicated} after dedup, ${c.executed} executed: ` +
    `${c.caught} caught, ${c.unverified} unverified, ${c.caughtElsewhere} caught only by the wider suite ` +
    `(${Math.round(report.timing.totalMs / 1000)}s)`
  );
}
