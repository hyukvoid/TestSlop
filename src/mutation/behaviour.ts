/**
 * Behavioural alternatives, replacing syntactic mutation.
 *
 * POC-01 generated mutants by rewriting operators and constants and then reported
 * whichever survived. Re-examining all 19 survivors (corpus/equivalence-taxonomy.ts)
 * showed that only 42% were the product working, and that the largest fixable
 * category — 21% — was not equivalence at all but **redundancy**: three separate
 * findings describing one missing input class.
 *
 * The fix is to stop thinking in edits and start thinking in **distinguishing
 * inputs**. For every candidate change, compute the input on which the original and
 * the alternative observably disagree. That single idea does four jobs at once:
 *
 *   1. it is the deduplication key — `size < 2` and `size <= 1` are the same
 *      predicate and must be one finding, not two
 *   2. it is the report, in developer language — "size = 1 is not constrained"
 *      instead of "constant 1 mutated to 2"
 *   3. it bounds generation — two probes per comparison rather than four edits
 *   4. it makes a false positive cheap to dismiss: a developer reading
 *      "status = 600" knows in one second that HTTP stops at 599
 *
 * Point 4 matters more than it looks. POC-01 spent its effort trying to *prove*
 * equivalence. Naming the input instead makes proof unnecessary for triage.
 */

import ts from "typescript";
import { createSourceFile } from "../adapters/ts/parse-test.ts";

export type AlternativeKind =
  /** A comparison threshold, the highest-value class. */
  | "boundary"
  /** The sense of an equality or comparison. */
  | "relation"
  /** How conditions combine. */
  | "logic"
  /** Arithmetic in a value-bearing expression. */
  | "arithmetic"
  /** A behaviour-bearing constant that is not a comparison threshold. */
  | "constant"
  /** A boolean literal that selects behaviour. */
  | "flag";

/**
 * Confidence that a surviving alternative represents behaviour a developer cares
 * about. Exposed rather than hidden, because POC-01 showed that suppressing
 * aggressively risks losing real findings while proving equivalence is expensive.
 */
export type Confidence =
  /** A named concrete input distinguishes the two, at a decision site. */
  | "high"
  /** Behaviour differs, but the distinguishing input is a class rather than a value. */
  | "medium"
  /** Coarse change; the distinguishing input is broad or hard to characterise. */
  | "low";

export interface DistinguishingInput {
  /** Developer-language description, used verbatim in the report. */
  description: string;
  /**
   * Canonical identity. Two alternatives with the same key describe the same
   * behavioural gap and are reported once.
   */
  key: string;
  /** The observed expression, when identifiable. */
  subject?: string;
  /** The concrete value at which behaviour diverges, when computable. */
  value?: string;
}

export interface BehaviouralAlternative {
  file: string;
  line: number;
  start: number;
  end: number;
  /** Source text being replaced. */
  original: string;
  replacement: string;
  /** The full expression the edit sits inside, for the report. */
  context: string;
  kind: AlternativeKind;
  confidence: Confidence;
  distinguishing: DistinguishingInput;
  enclosing?: string;
  /** Lower runs first when the budget is tight. */
  priority: number;
}

const COMPARISONS: Partial<Record<ts.SyntaxKind, "<" | "<=" | ">" | ">=">> = {
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
};

const EQUALITIES: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
};

const LOGICAL: Partial<Record<ts.SyntaxKind, "&&" | "||">> = {
  [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
  [ts.SyntaxKind.BarBarToken]: "||",
};

const ARITHMETIC: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
  [ts.SyntaxKind.PercentToken]: "%",
};

const RELAX: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };

function normalise(text: string): string {
  return text.replace(/\s+/g, "");
}

function numericLiteralValue(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  return undefined;
}

/**
 * The value at which `lhs OP k` and `lhs OP (k + delta)` disagree.
 *
 * Derived rather than guessed, because the first implementation got two of the four
 * operators wrong and reported an off-by-one distinguishing input — which is the one
 * number in the whole report a developer will check first.
 *
 * Each predicate defines a true-region; shifting the threshold moves its edge by one,
 * and the differing value is whichever integer crosses the edge:
 *
 *   `lhs <  k`  ->  `lhs <  k+1`   region (-inf,k) becomes (-inf,k+1)   differs at k
 *   `lhs <= k`  ->  `lhs <= k+1`   region (-inf,k] becomes (-inf,k+1]   differs at k+1
 *   `lhs >  k`  ->  `lhs >  k-1`   region (k,inf)  becomes (k-1,inf)    differs at k
 *   `lhs >= k`  ->  `lhs >= k-1`   region [k,inf)  becomes [k-1,inf)    differs at k-1
 *
 * A consequence worth noting: for the strict operators the shifted threshold is the
 * *same predicate* as the relaxed operator (`x < 601` is `x <= 600`), so the two probes
 * share a distinguishing value and collapse into one finding. That is correct, and it is
 * why deduplicating on the distinguishing input rather than on the edit matters.
 */
function shiftedThreshold(
  op: "<" | "<=" | ">" | ">=",
  k: number,
): { literal: number; differsAt: number } {
  switch (op) {
    case "<":
      return { literal: k + 1, differsAt: k };
    case "<=":
      return { literal: k + 1, differsAt: k + 1 };
    case ">":
      return { literal: k - 1, differsAt: k };
    case ">=":
      return { literal: k - 1, differsAt: k - 1 };
  }
}

/** Formats a threshold without float noise (0.5 + 1 must not print as 1.5000000000000002). */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
}

/**
 * Sites that produce *oblique* findings: real behavioural differences reported in a
 * way no developer would recognise as the actual gap.
 *
 * Both POC-01 oblique survivors were of this shape — a `reduce()` seed and a
 * `?? money(0)` default. The behaviour they expose (an untested tier boundary, an
 * untested rounding case) is better reached by mutating the decision site itself,
 * which the generator also does. Excluding them removes noise without losing signal.
 */
function isObliqueSite(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;

  // reduce(fn, SEED) / reduceRight(fn, SEED)
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    if ((method === "reduce" || method === "reduceRight") && parent.arguments.length >= 2) {
      if (parent.arguments[parent.arguments.length - 1] === node) return true;
    }
  }

  // `x ?? DEFAULT` and `x || DEFAULT` used as a fallback initialiser
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if ((op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) && parent.right === node) {
      return true;
    }
  }

  // A literal inside a call that is itself the right side of ?? — e.g. `?? money(0)`
  if (ts.isCallExpression(parent) && parent.parent && ts.isBinaryExpression(parent.parent)) {
    const op = parent.parent.operatorToken.kind;
    if (op === ts.SyntaxKind.QuestionQuestionToken && parent.parent.right === parent) return true;
  }

  return false;
}

/** Array indices and `.length` offsets produce crashes rather than behaviour changes. */
function isStructuralIndex(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  return false;
}

export interface GenerateOptions {
  /** Only consider these 1-based lines. Empty means the whole file. */
  lines: number[];
  /** Cap per file. */
  limit?: number;
}

export function generateAlternatives(
  filePath: string,
  content: string,
  opts: GenerateOptions,
): BehaviouralAlternative[] {
  const sf = createSourceFile(filePath, content);
  const allowed = new Set(opts.lines);
  const out: BehaviouralAlternative[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const fnStack: string[] = [];
  const enclosing = (): string | undefined => fnStack[fnStack.length - 1];

  const push = (a: Omit<BehaviouralAlternative, "enclosing">): void => {
    if (allowed.size > 0 && !allowed.has(a.line)) return;
    const fn = enclosing();
    out.push(fn ? { ...a, enclosing: fn } : a);
  };

  const nameOf = (node: ts.Node): string | undefined => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const p = node.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node);
    if (isFn) fnStack.push(nameOf(node) ?? enclosing() ?? "<anonymous>");

    try {
      inspect(node);
      ts.forEachChild(node, visit);
    } finally {
      if (isFn) fnStack.pop();
    }
  };

  const inspect = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const opNode = node.operatorToken;
      const opStart = opNode.getStart(sf);
      const opEnd = opNode.getEnd();
      const line = lineOf(opStart);
      const context = node.getText(sf).replace(/\s+/g, " ").trim();
      const cmp = COMPARISONS[opNode.kind];

      // ---- Comparisons: the highest-value class -----------------------------
      if (cmp) {
        const lhs = node.left.getText(sf).replace(/\s+/g, " ").trim();
        const rhsLiteral = numericLiteralValue(node.right);
        const rhsText = node.right.getText(sf).replace(/\s+/g, " ").trim();

        // Probe 1: is the behaviour exactly AT the threshold pinned?
        // `x <= k` vs `x < k` differ only when x === k.
        const relaxed = RELAX[cmp]!;
        push({
          file: filePath,
          line,
          start: opStart,
          end: opEnd,
          original: cmp,
          replacement: relaxed,
          context,
          kind: "boundary",
          confidence: "high",
          distinguishing: {
            description:
              rhsLiteral !== undefined
                ? `${lhs} = ${rhsLiteral}`
                : `${lhs} exactly equal to ${rhsText}`,
            // Canonical: the observed subject plus the value at which the two
            // predicates disagree. `x < 2` and `x <= 1` collapse onto one key.
            key: `${filePath}|${normalise(lhs)}|eq|${rhsLiteral !== undefined ? rhsLiteral : normalise(rhsText)}`,
            subject: lhs,
            ...(rhsLiteral !== undefined ? { value: String(rhsLiteral) } : {}),
          },
          priority: 0,
        });

        // Probe 2: shift the threshold by one. For `<=` and `>=` this reaches the value
        // just outside the current region — the probe that produced POC-01's clearest
        // finding (`quantity <= 0` -> `<= 1`, unconstrained at quantity = 1). For the
        // strict operators it collapses onto probe 1, which is correct.
        if (rhsLiteral !== undefined && ts.isNumericLiteral(node.right)) {
          const shifted = shiftedThreshold(cmp, rhsLiteral);
          const litStart = node.right.getStart(sf);
          push({
            file: filePath,
            line: lineOf(litStart),
            start: litStart,
            end: node.right.getEnd(),
            original: String(rhsLiteral),
            replacement: num(shifted.literal),
            context,
            kind: "boundary",
            confidence: "high",
            distinguishing: {
              description: `${lhs} = ${num(shifted.differsAt)}`,
              key: `${filePath}|${normalise(lhs)}|eq|${num(shifted.differsAt)}`,
              subject: lhs,
              value: num(shifted.differsAt),
            },
            priority: 1,
          });
        }
        return;
      }

      // ---- Equality: shift the compared value rather than flip the sense ----
      // Flipping `===` to `!==` differs for every input, which is too coarse to name
      // and produced POC-01's one out-of-contract survivor. Shifting the compared
      // constant gives a nameable distinguishing input.
      const eq = EQUALITIES[opNode.kind];
      if (eq) {
        const lhs = node.left.getText(sf).replace(/\s+/g, " ").trim();
        const rhsLiteral = numericLiteralValue(node.right);
        if (rhsLiteral !== undefined && ts.isNumericLiteral(node.right)) {
          // `x === k` vs `x === k+1` disagree at both k and k+1. The interesting one is
          // k, the value the code was written to recognise.
          const litStart = node.right.getStart(sf);
          push({
            file: filePath,
            line: lineOf(litStart),
            start: litStart,
            end: node.right.getEnd(),
            original: String(rhsLiteral),
            replacement: num(rhsLiteral + 1),
            context,
            kind: "boundary",
            confidence: "high",
            distinguishing: {
              description: `${lhs} = ${num(rhsLiteral)}`,
              key: `${filePath}|${normalise(lhs)}|eq|${num(rhsLiteral)}`,
              subject: lhs,
              value: num(rhsLiteral),
            },
            priority: 1,
          });
          return;
        }
        push({
          file: filePath,
          line,
          start: opStart,
          end: opEnd,
          original: eq,
          replacement: eq.startsWith("!") ? eq.replace("!", "=").slice(0, 3) : `!${eq.slice(1)}`,
          context,
          kind: "relation",
          confidence: "low",
          distinguishing: {
            description: `any input where \`${context}\` currently decides the outcome`,
            key: `${filePath}|${normalise(context)}|sense`,
          },
          priority: 4,
        });
        return;
      }

      // ---- Logical combination ---------------------------------------------
      const logical = LOGICAL[opNode.kind];
      if (logical) {
        push({
          file: filePath,
          line,
          start: opStart,
          end: opEnd,
          original: logical,
          replacement: logical === "&&" ? "||" : "&&",
          context,
          kind: "logic",
          confidence: "medium",
          distinguishing: {
            description: `an input where \`${node.left.getText(sf).replace(/\s+/g, " ").trim()}\` and \`${node.right.getText(sf).replace(/\s+/g, " ").trim()}\` disagree`,
            key: `${filePath}|${normalise(context)}|logic`,
          },
          priority: 3,
        });
        return;
      }

      // ---- Arithmetic -------------------------------------------------------
      const arith = ARITHMETIC[opNode.kind];
      if (arith && !isStringConcat(node, sf)) {
        const swap: Record<string, string> = { "+": "-", "-": "+", "*": "/", "/": "*", "%": "*" };
        push({
          file: filePath,
          line,
          start: opStart,
          end: opEnd,
          original: arith,
          replacement: swap[arith]!,
          context,
          kind: "arithmetic",
          confidence: "medium",
          distinguishing: {
            description: `any input that reaches \`${context}\``,
            // Keyed on the expression, not on which token was edited. Mutating the `+`
            // in `lower + 1` and mutating the `1` describe the same unreached
            // expression; POC-01 reported both, and POC-02's first pass still did
            // because the keys differed by operator. One expression, one finding.
            key: `${filePath}|${normalise(context)}|value`,
          },
          priority: 2,
        });
      }
      return;
    }

    // ---- Standalone behaviour-bearing constants ---------------------------
    // Only when not already handled as a comparison threshold, not an array index,
    // and not an oblique accumulator seed or fallback default.
    if (ts.isNumericLiteral(node)) {
      if (isStructuralIndex(node) || isObliqueSite(node)) return;
      const parent = node.parent;
      // Comparison thresholds were handled above with a proper distinguishing input.
      if (parent && ts.isBinaryExpression(parent) && (COMPARISONS[parent.operatorToken.kind] || EQUALITIES[parent.operatorToken.kind])) {
        return;
      }
      const value = Number(node.text);
      if (!Number.isFinite(value)) return;
      const start = node.getStart(sf);
      const context = (parent?.getText(sf) ?? node.getText(sf)).replace(/\s+/g, " ").trim().slice(0, 90);
      push({
        file: filePath,
        line: lineOf(start),
        start,
        end: node.getEnd(),
        original: node.text,
        replacement: String(value + 1),
        context,
        kind: "constant",
        confidence: "medium",
        // Same key as the arithmetic probe on this expression, so the two collapse.
        distinguishing: {
          description: `any input that reaches \`${context}\``,
          key: `${filePath}|${normalise(context)}|value`,
        },
        priority: 3,
      });
      return;
    }

    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      if (isObliqueSite(node)) return;
      const isTrue = node.kind === ts.SyntaxKind.TrueKeyword;
      const start = node.getStart(sf);
      const context = (node.parent?.getText(sf) ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
      push({
        file: filePath,
        line: lineOf(start),
        start,
        end: node.getEnd(),
        original: isTrue ? "true" : "false",
        replacement: isTrue ? "false" : "true",
        context,
        kind: "flag",
        confidence: "medium",
        distinguishing: {
          description: `any input that reaches the \`${isTrue ? "true" : "false"}\` in \`${context}\``,
          key: `${filePath}|${normalise(context)}|flag`,
        },
        priority: 3,
      });
    }
  };

  ts.forEachChild(sf, visit);

  // Deduplicate by distinguishing input. This is the change that removes POC-01's
  // largest noise category: three edits describing one missing input class become
  // one finding, and `x < 2` / `x <= 1` stop being reported twice.
  const seen = new Map<string, BehaviouralAlternative>();
  for (const a of out) {
    const existing = seen.get(a.distinguishing.key);
    if (!existing || a.priority < existing.priority) seen.set(a.distinguishing.key, a);
  }

  const deduped = [...seen.values()].sort((a, b) => a.priority - b.priority || a.start - b.start);
  return opts.limit ? deduped.slice(0, opts.limit) : deduped;
}

function isStringConcat(node: ts.BinaryExpression, sf: ts.SourceFile): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  const l = node.left;
  const r = node.right;
  return (
    ts.isStringLiteralLike(l) ||
    ts.isStringLiteralLike(r) ||
    ts.isTemplateExpression(l) ||
    ts.isTemplateExpression(r)
  );
}

export function applyAlternative(content: string, a: BehaviouralAlternative): string {
  return content.slice(0, a.start) + a.replacement + content.slice(a.end);
}
