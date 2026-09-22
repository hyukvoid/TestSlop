/**
 * Mutation operators, scoped to changed lines.
 *
 * The scoping is the whole idea. A general mutation-testing tool asks "how good
 * is this test suite?", generates thousands of mutants and takes minutes to
 * hours. TestSlop asks a much narrower question:
 *
 *     The diff changed this specific decision. Do the tests that changed
 *     alongside it actually notice when that decision is wrong?
 *
 * That reduces the mutant set from "the whole program" to "the operators and
 * constants on the lines this commit touched", which is usually single digits.
 * It also makes each surviving mutant *interpretable*: it is attached to a line
 * the author just wrote, so the report can say what behaviour is unverified
 * rather than handing over a coverage-style percentage.
 *
 * Boundary-shifting operators (>= to >) are prioritised over arithmetic ones
 * because they are the mutations most likely to expose a missing boundary test,
 * which is the specific gap agent-written tests tend to leave.
 */

import ts from "typescript";
import { createSourceFile } from "../adapters/ts/parse-test.ts";

export interface Mutant {
  /** Repo-relative file the mutation applies to. */
  file: string;
  line: number;
  /** Character offset range in the original text. */
  start: number;
  end: number;
  original: string;
  replacement: string;
  operator: string;
  /** Prose for the report: what behaviour this mutant breaks. */
  describes: string;
  /** Priority; lower runs first when the budget is tight. */
  priority: number;
}

const BOUNDARY_SWAPS: Record<string, string> = {
  ">=": ">",
  ">": ">=",
  "<=": "<",
  "<": "<=",
};

const EQUALITY_SWAPS: Record<string, string> = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
};

const LOGICAL_SWAPS: Record<string, string> = {
  "&&": "||",
  "||": "&&",
};

const ARITHMETIC_SWAPS: Record<string, string> = {
  "+": "-",
  "-": "+",
  "*": "/",
  "/": "*",
};

const OPERATOR_TEXT: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
  [ts.SyntaxKind.BarBarToken]: "||",
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
};

export interface GenerateOptions {
  /** Only mutate these 1-based lines. Empty means the whole file. */
  lines: number[];
  /** Maximum mutants to return for this file. */
  limit?: number;
}

export function generateMutants(filePath: string, content: string, opts: GenerateOptions): Mutant[] {
  const sf = createSourceFile(filePath, content);
  const allowed = new Set(opts.lines);
  const mutants: Mutant[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const push = (m: Mutant): void => {
    if (allowed.size > 0 && !allowed.has(m.line)) return;
    mutants.push(m);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const opNode = node.operatorToken;
      const text = OPERATOR_TEXT[opNode.kind];
      if (text) {
        const start = opNode.getStart(sf);
        const end = opNode.getEnd();
        const line = lineOf(start);

        if (BOUNDARY_SWAPS[text]) {
          push({
            file: filePath,
            line,
            start,
            end,
            original: text,
            replacement: BOUNDARY_SWAPS[text]!,
            operator: "boundary",
            describes: `the boundary of \`${node.getText(sf).replace(/\s+/g, " ").slice(0, 60)}\``,
            priority: 0,
          });
        } else if (EQUALITY_SWAPS[text]) {
          push({
            file: filePath,
            line,
            start,
            end,
            original: text,
            replacement: EQUALITY_SWAPS[text]!,
            operator: "equality",
            describes: `the sense of \`${node.getText(sf).replace(/\s+/g, " ").slice(0, 60)}\``,
            priority: 1,
          });
        } else if (LOGICAL_SWAPS[text]) {
          push({
            file: filePath,
            line,
            start,
            end,
            original: text,
            replacement: LOGICAL_SWAPS[text]!,
            operator: "logical",
            describes: `how the conditions in \`${node.getText(sf).replace(/\s+/g, " ").slice(0, 60)}\` combine`,
            priority: 2,
          });
        } else if (ARITHMETIC_SWAPS[text] && !isStringConcat(node, sf)) {
          push({
            file: filePath,
            line,
            start,
            end,
            original: text,
            replacement: ARITHMETIC_SWAPS[text]!,
            operator: "arithmetic",
            describes: `the arithmetic in \`${node.getText(sf).replace(/\s+/g, " ").slice(0, 60)}\``,
            priority: 3,
          });
        }
      }
    }

    // Numeric literal off-by-one. Skips array indices and common loop bounds
    // where an off-by-one produces a crash rather than a behavioural difference.
    if (ts.isNumericLiteral(node) && !ts.isElementAccessExpression(node.parent)) {
      const value = Number(node.text);
      if (Number.isFinite(value)) {
        const start = node.getStart(sf);
        push({
          file: filePath,
          line: lineOf(start),
          start,
          end: node.getEnd(),
          original: node.text,
          replacement: String(value + 1),
          operator: "constant",
          describes: `the constant ${node.text}`,
          priority: 2,
        });
      }
    }

    // Boolean literal flip.
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const isTrue = node.kind === ts.SyntaxKind.TrueKeyword;
      const start = node.getStart(sf);
      push({
        file: filePath,
        line: lineOf(start),
        start,
        end: node.getEnd(),
        original: isTrue ? "true" : "false",
        replacement: isTrue ? "false" : "true",
        operator: "boolean",
        describes: `the literal \`${isTrue ? "true" : "false"}\``,
        priority: 2,
      });
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  // Deterministic order: priority, then position. Determinism matters because
  // the report is compared across runs in the evaluation harness.
  mutants.sort((a, b) => a.priority - b.priority || a.start - b.start);
  return opts.limit ? mutants.slice(0, opts.limit) : mutants;
}

/** `+` between strings is concatenation; swapping it to `-` yields NaN noise. */
function isStringConcat(node: ts.BinaryExpression, sf: ts.SourceFile): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const l = node.left;
  const r = node.right;
  return ts.isStringLiteralLike(l) || ts.isStringLiteralLike(r) || ts.isTemplateExpression(l) || ts.isTemplateExpression(r);
}

export function applyMutant(content: string, mutant: Mutant): string {
  return content.slice(0, mutant.start) + mutant.replacement + content.slice(mutant.end);
}
