/**
 * Extracts "value-bearing" signals from a production file.
 *
 * The point is not to understand the program. It is to build a comparable
 * fingerprint of the decisions encoded in the source — constants, comparison
 * operators, thrown errors, branch conditions — so that the same fingerprint
 * taken at two revisions reveals what behaviour the author changed. Rules then
 * ask whether the test diff responded to that change in a meaningful way.
 */

import ts from "typescript";
import type { ProductionFileModel, ProductionSignal } from "../../core/types.ts";
import { createSourceFile } from "./parse-test.ts";

const COMPARISON_TOKENS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
};

const LOGICAL_TOKENS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
  [ts.SyntaxKind.BarBarToken]: "||",
  [ts.SyntaxKind.QuestionQuestionToken]: "??",
};

const ARITHMETIC_TOKENS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
  [ts.SyntaxKind.PercentToken]: "%",
};

/** Patterns that suppress coverage measurement. */
const COVERAGE_IGNORE = /(istanbul\s+ignore|c8\s+ignore|v8\s+ignore|node:coverage\s+(disable|ignore)|pragma:\s*no\s*cover)/;

/**
 * Production code that behaves differently under test is one of the most
 * damaging accommodations an agent can make, and it is invisible to both
 * coverage and test linters (it lives in production source, not test source).
 */
const TEST_ENV_BRANCH =
  /(NODE_ENV\s*[=!]==?\s*['"]test['"]|['"]test['"]\s*[=!]==?\s*NODE_ENV|JEST_WORKER_ID|VITEST_WORKER_ID|process\.env\.VITEST|process\.env\.JEST|__TEST__|isTestEnv|IS_TEST\b|SKIP_VALIDATION|BYPASS_AUTH)/;

export function parseProductionFile(filePath: string, content: string): ProductionFileModel {
  const problems: string[] = [];
  let sf: ts.SourceFile;
  try {
    sf = createSourceFile(filePath, content);
  } catch (err) {
    return {
      path: filePath,
      signals: [],
      exportedNames: [],
      returnExpressions: new Map(),
      problems: [`parse failed: ${(err as Error).message}`],
    };
  }

  const signals: ProductionSignal[] = [];
  const exportedNames: string[] = [];
  const returnExpressions = new Map<string, string[]>();
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  // Line-based scan for comment pragmas, which the AST does not expose as nodes.
  content.split(/\r?\n/).forEach((text, idx) => {
    if (COVERAGE_IGNORE.test(text)) {
      signals.push({ line: idx + 1, kind: "coverage-ignore", text: text.trim().slice(0, 160) });
    }
    if (TEST_ENV_BRANCH.test(text)) {
      signals.push({ line: idx + 1, kind: "test-environment-branch", text: text.trim().slice(0, 160) });
    }
  });

  const functionStack: string[] = [];
  const currentFn = (): string | undefined => functionStack[functionStack.length - 1];

  const nameOfFunctionLike = (node: ts.Node): string | undefined => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (parent && ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
    if (ts.isClassDeclaration(node) && node.name) return node.name.text;
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    const isFnLike =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node);

    if (isFnLike) {
      const name = nameOfFunctionLike(node);
      functionStack.push(name ?? currentFn() ?? "<anonymous>");
    }

    // Exported surface, used to link tests to production modules by symbol.
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      exportedNames.push(node.name.text);
    }
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) exportedNames.push(decl.name.text);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) exportedNames.push(el.name.text);
    }

    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      // 0 and 1 are too common to be useful correlation signals on their own.
      signals.push({
        line: lineOf(node.getStart(sf)),
        kind: "numeric-literal",
        text: node.text,
        numeric: value,
        enclosing: currentFn(),
      });
    } else if (ts.isStringLiteralLike(node) && node.text.length > 0 && node.text.length < 120) {
      signals.push({
        line: lineOf(node.getStart(sf)),
        kind: "string-literal",
        text: node.text,
        enclosing: currentFn(),
      });
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      signals.push({
        line: lineOf(node.getStart(sf)),
        kind: "boolean-literal",
        text: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false",
        enclosing: currentFn(),
      });
    } else if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const cmp = COMPARISON_TOKENS[kind];
      const logical = LOGICAL_TOKENS[kind];
      const arith = ARITHMETIC_TOKENS[kind];
      if (cmp) {
        signals.push({
          line: lineOf(node.operatorToken.getStart(sf)),
          kind: "comparison-operator",
          text: node.getText(sf).replace(/\s+/g, " ").trim().slice(0, 160),
          enclosing: currentFn(),
        });
      } else if (logical) {
        signals.push({
          line: lineOf(node.operatorToken.getStart(sf)),
          kind: "logical-operator",
          text: logical,
          enclosing: currentFn(),
        });
      } else if (arith) {
        signals.push({
          line: lineOf(node.operatorToken.getStart(sf)),
          kind: "arithmetic-operator",
          text: node.getText(sf).replace(/\s+/g, " ").trim().slice(0, 160),
          enclosing: currentFn(),
        });
      }
    } else if (ts.isReturnStatement(node) && node.expression) {
      const raw = node.expression.getText(sf).replace(/\s+/g, " ").trim();
      const fn = currentFn();
      signals.push({
        line: lineOf(node.getStart(sf)),
        kind: "return-expression",
        text: raw.slice(0, 200),
        enclosing: fn,
      });
      if (fn) {
        const list = returnExpressions.get(fn) ?? [];
        list.push(raw);
        returnExpressions.set(fn, list);
      }
    } else if (ts.isIfStatement(node)) {
      signals.push({
        line: lineOf(node.getStart(sf)),
        kind: "conditional",
        text: node.expression.getText(sf).replace(/\s+/g, " ").trim().slice(0, 200),
        enclosing: currentFn(),
      });
    } else if (ts.isThrowStatement(node)) {
      signals.push({
        line: lineOf(node.getStart(sf)),
        kind: "throw",
        text: node.expression.getText(sf).replace(/\s+/g, " ").trim().slice(0, 200),
        enclosing: currentFn(),
      });
    }

    ts.forEachChild(node, visit);

    if (isFnLike) functionStack.pop();
  };

  ts.forEachChild(sf, visit);

  return { path: filePath, signals, exportedNames, returnExpressions, problems };
}
