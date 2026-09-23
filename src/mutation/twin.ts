import path from "node:path";
import ts from "typescript";
import type { ChangeSet } from "../core/types.ts";
import {
  applyAlternative,
  type BehaviouralAlternative,
} from "./behaviour.ts";
import {
  detectTestCommand,
  verifyChangedBehaviour,
  type Outcome,
} from "./behaviour-verify.ts";
import { createSandbox } from "./sandbox.ts";
import { parseTestSummary, runTestCommand, type TestSummary } from "./test-runner.ts";

export interface TwinOptions {
  budget?: number;
  timeoutMs?: number;
  testCommand?: string;
  modulesFrom?: string;
  onProgress?: (message: string) => void;
}

export interface TwinEvidence {
  file: string;
  line: number;
  original: string;
  twin: string;
  originalTests?: TestSummary;
  twinTests?: TestSummary;
  witness: string;
  testCommand: string;
  additionalSurvivors: number;
}

export type TwinReport =
  | { status: "found"; evidence: TwinEvidence; generated: number; checked: number }
  | { status: "none"; reason: string; generated: number; checked: number }
  | { status: "baseline-failed"; detail: string; generated: number; checked: number }
  | { status: "error"; detail: string; generated: number; checked: number };

const DEFAULT_BUDGET = 12;
const DEFAULT_TIMEOUT_MS = 180_000;

function isCredibleShape(alternative: BehaviouralAlternative): boolean {
  if (alternative.kind !== "boundary" || alternative.confidence !== "high") return false;
  if (!alternative.distinguishing.subject) return false;
  // The default output only promises a witness for a concrete value or a simple named
  // threshold. Broad boolean and arithmetic rewrites stay in the advanced verifier.
  return alternative.distinguishing.value !== undefined ||
    /^.+ exactly equal to [A-Za-z_$][\w$]*$/.test(alternative.distinguishing.description);
}

function renderChangedExpression(alternative: BehaviouralAlternative): string {
  const index = alternative.context.indexOf(alternative.original);
  if (index < 0) return alternative.context;
  return alternative.context.slice(0, index) + alternative.replacement +
    alternative.context.slice(index + alternative.original.length);
}

function evaluateConstant(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  seen = new Set<string>(),
): number | undefined {
  if (ts.isNumericLiteral(expression)) {
    const value = Number(expression.text.replaceAll("_", ""));
    return Number.isFinite(value) ? value : undefined;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return evaluateConstant(expression.expression, sourceFile, seen);
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    const value = evaluateConstant(expression.operand, sourceFile, seen);
    if (value === undefined) return undefined;
    if (expression.operator === ts.SyntaxKind.MinusToken) return -value;
    if (expression.operator === ts.SyntaxKind.PlusToken) return value;
    return undefined;
  }
  if (ts.isIdentifier(expression)) {
    const name = expression.text;
    if (seen.has(name)) return undefined;
    seen.add(name);
    let value: number | undefined;
    const visit = (node: ts.Node): void => {
      if (value !== undefined) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
        const declarationList = node.parent;
        if (ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0) {
          value = evaluateConstant(node.initializer, sourceFile, seen);
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return value;
  }
  if (ts.isBinaryExpression(expression)) {
    const left = evaluateConstant(expression.left, sourceFile, new Set(seen));
    const right = evaluateConstant(expression.right, sourceFile, new Set(seen));
    if (left === undefined || right === undefined) return undefined;
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return right === 0 ? undefined : left / right;
      case ts.SyntaxKind.PercentToken: return right === 0 ? undefined : left % right;
      case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
      default: return undefined;
    }
  }
  return undefined;
}

function witnessFor(alternative: BehaviouralAlternative, source: string): string {
  if (alternative.distinguishing.value !== undefined) {
    return `${alternative.distinguishing.subject} = ${alternative.distinguishing.value}`;
  }

  const match = /^(.+?) exactly equal to (.+)$/.exec(alternative.distinguishing.description);
  if (!match?.[1] || !match[2]) return alternative.distinguishing.description;

  const sourceFile = ts.createSourceFile(alternative.file, source, ts.ScriptTarget.Latest, true);
  let resolved: number | undefined;
  const visit = (node: ts.Node): void => {
    if (resolved !== undefined) return;
    if (node.getText(sourceFile) === match[2]) resolved = evaluateConstant(node as ts.Expression, sourceFile);
    if (resolved === undefined) ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (resolved === undefined) return alternative.distinguishing.description;
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(resolved);
  if (match[1] === "msAbs") {
    const inputName = /const\s+msAbs\s*=\s*Math\.abs\(\s*([\w$]+)\s*\)/.exec(source)?.[1];
    if (inputName) return `${inputName} = ${formatted} ms`;
  }
  return `${match[1]} = ${formatted}`;
}

export async function findEvilTwin(changeSet: ChangeSet, options: TwinOptions = {}): Promise<TwinReport> {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const verification = await verifyChangedBehaviour(changeSet, {
    budget,
    timeoutMs,
    stopAfterFindings: budget,
    validateLinking: true,
    reuseSandbox: false,
    ...(options.testCommand !== undefined ? { testCommand: options.testCommand } : {}),
    ...(options.modulesFrom !== undefined ? { modulesFrom: options.modulesFrom } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const counts = { generated: verification.counts.generated, checked: verification.counts.executed };
  if (!verification.baseline.ok) {
    if (verification.baseline.detail.includes("no behavioural alternatives") ||
        verification.baseline.detail.includes("no changed production files")) {
      return { status: "none", reason: "No supported nearby boundary was found in the changed production lines.", ...counts };
    }
    if (verification.testCommand === "<none>") {
      return { status: "error", detail: verification.baseline.detail, ...counts };
    }
    if (verification.baseline.detail.startsWith("baseline is red") || verification.baseline.detail.includes("baseline timed out")) {
      return { status: "baseline-failed", detail: verification.baseline.detail, ...counts };
    }
    return { status: "error", detail: verification.baseline.detail, ...counts };
  }

  const survivors = verification.results
    .filter((result) => result.outcome === "unverified" && isCredibleShape(result.alternative))
    .sort((left, right) =>
      left.alternative.priority - right.alternative.priority ||
      left.alternative.file.localeCompare(right.alternative.file) ||
      left.alternative.line - right.alternative.line ||
      left.alternative.start - right.alternative.start,
    );
  const selected = survivors[0];
  if (!selected) {
    return {
      status: "none",
      reason: verification.counts.unverified > 0
        ? "No concrete, readable boundary alternative survived the full test suite."
        : "The tests caught the nearby alternatives that TestSlop checked.",
      ...counts,
    };
  }

  const changedFile = changeSet.files.find((file) => file.path === selected.alternative.file);
  const source = changedFile?.after;
  if (source === undefined) {
    return { status: "error", detail: "The selected source file is not present in the analyzed revision.", ...counts };
  }
  const command = options.testCommand ?? (await detectTestCommand(changeSet.repoRoot))?.command;
  if (!command) return { status: "error", detail: "No supported test command was detected.", ...counts };

  let sandbox;
  try {
    sandbox = await createSandbox(changeSet.repoRoot, {
      reuse: false,
      ...(options.modulesFrom !== undefined ? { modulesFrom: options.modulesFrom } : {}),
    });
  } catch (error) {
    return { status: "error", detail: `Could not create a disposable copy: ${(error as Error).message}`, ...counts };
  }

  try {
    for (const file of changeSet.files) {
      if (file.role === "production" && file.after !== undefined) {
        await sandbox.write(file.path, file.after);
      }
    }
    const baseline = await runTestCommand(command, sandbox.root, timeoutMs);
    if (baseline.code !== 0) {
      return {
        status: "baseline-failed",
        detail: baseline.timedOut ? `The original suite timed out after ${timeoutMs} ms.` : "The original suite failed during the final full-suite replay.",
        ...counts,
      };
    }

    let twinSource: string;
    try {
      twinSource = applyAlternative(source, selected.alternative);
    } catch (error) {
      return { status: "error", detail: `Could not apply the selected alternative: ${(error as Error).message}`, ...counts };
    }
    await sandbox.write(selected.alternative.file, twinSource);
    const twin = await runTestCommand(command, sandbox.root, timeoutMs);
    if (twin.code !== 0) {
      return {
        status: "none",
        reason: twin.timedOut
          ? "The selected alternative timed out when replayed against the full suite."
          : "The selected alternative did not pass the final full-suite replay.",
        ...counts,
      };
    }

    return {
      status: "found",
      generated: counts.generated,
      checked: counts.checked,
      evidence: {
        file: selected.alternative.file,
        line: selected.alternative.line,
        original: selected.alternative.context,
        twin: renderChangedExpression(selected.alternative),
        ...(parseTestSummary(baseline.out) ? { originalTests: parseTestSummary(baseline.out)! } : {}),
        ...(parseTestSummary(twin.out) ? { twinTests: parseTestSummary(twin.out)! } : {}),
        witness: witnessFor(selected.alternative, source),
        testCommand: command,
        additionalSurvivors: survivors.length - 1,
      },
    };
  } finally {
    await sandbox.dispose();
  }
}

export function renderTwinReport(report: TwinReport): string {
  if (report.status === "found") {
    const { evidence } = report;
    const originalCount = evidence.originalTests
      ? `${evidence.originalTests.passed} / ${evidence.originalTests.total} tests passed`
      : "tests passed (count unavailable)";
    const twinCount = evidence.twinTests
      ? `${evidence.twinTests.passed} / ${evidence.twinTests.total} tests passed`
      : "tests passed (count unavailable)";
    return [
      "TestSlop",
      "",
      "Your implementation:",
      `  ${evidence.original}`,
      "",
      "Evil Twin:",
      `  ${evidence.twin}`,
      "",
      `ORIGINAL    ${originalCount}  ✓`,
      `EVIL TWIN   ${twinCount}  ✓`,
      "",
      "Your tests accept BOTH implementations.",
      "",
      "Missing witness:",
      `  ${evidence.witness}`,
      "",
      `  ${evidence.file}:${evidence.line}`,
      "",
    ].join("\n");
  }
  if (report.status === "none") {
    return [
      "No credible Evil Twin found for this diff.",
      "",
      "The tests may be tight, or this change may not fit TestSlop's supported shapes.",
      "No Twin found does not mean the code is verified correct.",
      "",
    ].join("\n");
  }
  if (report.status === "baseline-failed") {
    return [
      "The original test suite did not pass.",
      "Evil Twin search stopped; a green baseline is required.",
      `  ${report.detail}`,
      "",
    ].join("\n");
  }
  return [`TestSlop could not run the Evil Twin check.`, `  ${report.detail}`, ""].join("\n");
}

export function renderTwinJson(report: TwinReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
