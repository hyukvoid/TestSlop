#!/usr/bin/env node
/**
 * TestSlop CLI.
 *
 * Uses node:util parseArgs rather than a CLI framework. The surface is small
 * enough that a dependency would be harder to justify than the twenty lines it
 * replaces.
 */

import { parseArgs } from "node:util";
import { collectChangeSet } from "./core/changeset.ts";
import { analyse } from "./core/pipeline.ts";
import { GitError, listFilesAtRef } from "./core/git.ts";
import { ALL_RULES, excludeRules, rulesByIds } from "./rules/index.ts";
import { renderReport, renderRuleList } from "./report/human.ts";
import { toJsonReport } from "./report/json.ts";
import { verifyChangedBehaviour, behaviourFindings } from "./mutation/behaviour-verify.ts";
import type { Finding } from "./core/types.ts";

const VERSION = "0.0.0-poc.0";

const USAGE = `
TestSlop ${VERSION}
Tests passed. Now break the code and see if they notice.

Usage
  testslop verify [options]   Break the changed behaviour and check the tests catch it
  testslop scan [options]     Fast static-only analysis of the test diff
  testslop rules
  testslop --help

Options
  --base <ref>         Compare against this git ref. Default: HEAD
                       For a branch ref the merge base is used.
  --head <ref>         Compare up to this ref instead of the working tree.
  --staged             Compare the index instead of the working tree.
  --cwd <path>         Repository to analyse. Default: current directory.
  --json               Emit the machine-readable report on stdout.
  --budget <n>         Max behavioural alternatives to execute. Default: 12
  --stop-after <n>     Stop once this many unverified behaviours are found.
                       Default: 4
  --no-link-check      Skip the full-suite run that distinguishes "nothing
                       verifies this" from "the linked tests were too narrow".
  --test-command <cmd> Command used to run tests during verification.
                       Default: auto-detected from package.json
  --mutate             Deprecated alias for running verification inside \`scan\`.
  --rule <id>          Only run these rules. Repeatable.
  --skip-rule <id>     Skip these rules. Repeatable.
  --min-confidence <n> Drop findings below this confidence (0..1). Default: 0
  --fail-on <level>    Exit 1 when a finding at or above this severity exists.
                       One of: high, medium, low, never. Default: never
  --compact            One block per finding, no evidence.
  --quiet              Suppress the report; only set the exit code.

Examples
  testslop verify                        # the agent just finished: is it protected?
  testslop verify --base main            # verify a whole branch
  testslop scan                          # static only, milliseconds
  testslop verify --json > findings.json

Verification copies your working tree to a scratch directory and mutates only
there. Your files are never written to.
`;

interface Options {
  base?: string;
  head?: string;
  staged: boolean;
  cwd: string;
  json: boolean;
  mutate: boolean;
  mutateBudget: number;
  stopAfter: number;
  noLinkCheck: boolean;
  testCommand?: string;
  rule: string[];
  skipRule: string[];
  minConfidence: number;
  failOn: "high" | "medium" | "low" | "never";
  compact: boolean;
  quiet: boolean;
}

function fail(message: string): never {
  process.stderr.write(`testslop: ${message}\n`);
  process.exit(2);
}

function parse(argv: string[]): { command: string; options: Options } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        staged: { type: "boolean", default: false },
        cwd: { type: "string" },
        json: { type: "boolean", default: false },
        mutate: { type: "boolean", default: false },
        "mutate-budget": { type: "string" },
        budget: { type: "string" },
        "stop-after": { type: "string" },
        "no-link-check": { type: "boolean", default: false },
        "test-command": { type: "string" },
        rule: { type: "string", multiple: true },
        "skip-rule": { type: "string", multiple: true },
        "min-confidence": { type: "string" },
        "fail-on": { type: "string" },
        compact: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }

  const v = parsed.values;
  if (v.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (v.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const failOn = (v["fail-on"] ?? "never") as Options["failOn"];
  if (!["high", "medium", "low", "never"].includes(failOn)) {
    fail(`--fail-on must be one of high, medium, low, never (got "${failOn}")`);
  }

  const minConfidence = v["min-confidence"] !== undefined ? Number(v["min-confidence"]) : 0;
  if (Number.isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    fail("--min-confidence must be a number between 0 and 1");
  }

  const budgetRaw = v.budget ?? v["mutate-budget"];
  const budget = budgetRaw !== undefined ? Number(budgetRaw) : 12;
  if (!Number.isInteger(budget) || budget < 1) fail("--budget must be a positive integer");
  const stopAfter = v["stop-after"] !== undefined ? Number(v["stop-after"]) : 4;
  if (!Number.isInteger(stopAfter) || stopAfter < 1) fail("--stop-after must be a positive integer");

  const options: Options = {
    staged: v.staged ?? false,
    cwd: v.cwd ?? process.cwd(),
    json: v.json ?? false,
    mutate: v.mutate ?? false,
    mutateBudget: budget,
    stopAfter,
    noLinkCheck: v["no-link-check"] ?? false,
    rule: v.rule ?? [],
    skipRule: v["skip-rule"] ?? [],
    minConfidence,
    failOn,
    compact: v.compact ?? false,
    quiet: v.quiet ?? false,
  };
  if (v.base !== undefined) options.base = v.base;
  if (v.head !== undefined) options.head = v.head;
  if (v["test-command"] !== undefined) options.testCommand = v["test-command"];

  return { command: parsed.positionals[0] ?? "scan", options };
}

function exceedsThreshold(findings: Finding[], level: Options["failOn"]): boolean {
  if (level === "never") return false;
  const rank = { high: 3, medium: 2, low: 1 } as const;
  const threshold = rank[level];
  return findings.some((f) => rank[f.severity] >= threshold);
}

async function main(): Promise<void> {
  const { command, options } = parse(process.argv.slice(2));

  if (command === "rules") {
    process.stdout.write(renderRuleList(ALL_RULES));
    return;
  }
  if (command !== "scan" && command !== "verify") {
    fail(`unknown command "${command}". Try: testslop verify`);
  }
  // `verify` is `scan` plus behaviour verification. POC-02 promoted it to its own verb
  // because mutation stopped being the optional extra: it is the only layer that found
  // anything on independent agent output.
  const verifying = command === "verify" || options.mutate;

  let changeSet;
  try {
    const collectOpts: Parameters<typeof collectChangeSet>[0] = {
      cwd: options.cwd,
      staged: options.staged,
    };
    if (options.base !== undefined) collectOpts.base = options.base;
    if (options.head !== undefined) collectOpts.head = options.head;
    changeSet = await collectChangeSet(collectOpts);
  } catch (err) {
    if (err instanceof GitError) fail(err.message);
    throw err;
  }

  // Knowing every path at head makes relative import resolution exact rather
  // than limited to files that happen to appear in the diff.
  let knownPaths: string[] = [];
  try {
    knownPaths = await listFilesAtRef(changeSet.repoRoot, options.head ?? "HEAD");
  } catch {
    // Not fatal: resolution falls back to diff-local paths.
  }

  const selected = excludeRules(rulesByIds(options.rule.length ? options.rule : undefined), options.skipRule);

  const result = await analyse(changeSet, {
    rules: selected,
    knownPaths,
    minConfidence: options.minConfidence,
  });

  if (verifying) {
    const started = Date.now();
    const report = await verifyChangedBehaviour(changeSet, {
      budget: options.mutateBudget,
      stopAfterFindings: options.stopAfter,
      validateLinking: !options.noLinkCheck,
      ...(options.testCommand !== undefined ? { testCommand: options.testCommand } : {}),
      onProgress: options.quiet || options.json ? undefined : (msg) => process.stderr.write(`  ${msg}\n`),
    });
    result.findings = [...result.findings, ...behaviourFindings(report)];
    result.summary.findings = result.findings.length;
    result.summary.mutationDurationMs = Date.now() - started;
    const { sortFindings } = await import("./core/pipeline.ts");
    result.findings = sortFindings(result.findings);
  }

  if (!options.quiet) {
    if (options.json) {
      process.stdout.write(JSON.stringify(toJsonReport(result, VERSION), null, 2) + "\n");
    } else {
      process.stdout.write(renderReport(result, { compact: options.compact }));
    }
  }

  process.exit(exceedsThreshold(result.findings, options.failOn) ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`testslop: unexpected failure: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
});
