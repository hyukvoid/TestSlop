/**
 * Lowers a Jest/Vitest test file into the normalised `TestFileModel`.
 *
 * Uses the TypeScript compiler API in single-file mode (no program, no type
 * checker). That keeps parsing fast and, importantly, lets TestSlop parse a
 * file's *base revision* content which no longer exists on disk. A type-aware
 * approach would need a full program per revision and is not worth it for the
 * syntactic questions the rules ask.
 */

import ts from "typescript";
import type {
  Assertion,
  AssertionArg,
  Framework,
  ImplicitAssertion,
  ImportRecord,
  MockOp,
  TestCase,
  TestFileModel,
  TestModifier,
} from "../../core/types.ts";
import { classifyMatcher } from "./strength.ts";

/**
 * Calls that assert by throwing. Discovered the hard way: scanning zustand's
 * history produced "test no longer asserts anything" on a test that had been
 * rewritten to use an ErrorBoundary plus `getByText('errored')`, which is a
 * perfectly good oracle containing no `expect` call. Treating these as
 * assertions removed an entire class of false positive.
 */
const IMPLICIT_ASSERTION_CALL = /^(get|find)(All)?By[A-Z]\w*$/;
const IMPLICIT_ASSERTION_NAMES = new Set([
  "assert",
  "ok",
  "strictEqual",
  "deepStrictEqual",
  "notStrictEqual",
  "invariant",
  "waitFor",
  "waitForElement",
  "waitForElementToBeRemoved",
  "expectTypeOf",
  "assertType",
  "expectType",
  "assertSnapshot",
  "verify", // testdouble.js
  "verifyAll", // typemoq
]);

function isImplicitAssertionName(name: string): boolean {
  const leaf = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return IMPLICIT_ASSERTION_NAMES.has(leaf) || IMPLICIT_ASSERTION_CALL.test(leaf);
}

const TEST_FNS = new Set(["it", "test", "fit", "xit", "xtest", "specify"]);
const SUITE_FNS = new Set(["describe", "context", "suite", "xdescribe", "fdescribe"]);
const MOCK_APIS = new Set([
  "mock",
  "fn",
  "spyOn",
  "doMock",
  "mocked",
  "stub",
  "createMock",
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
  "mockImplementation",
  "mockImplementationOnce",
  "mockReturnThis",
]);

export function createSourceFile(filePath: string, content: string): ts.SourceFile {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const scriptKind =
    ext === ".tsx" ? ts.ScriptKind.TSX
    : ext === ".jsx" ? ts.ScriptKind.JSX
    : ext === ".js" || ext === ".mjs" || ext === ".cjs" ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function textOf(sf: ts.SourceFile, node: ts.Node): string {
  return node.getText(sf);
}

/**
 * Normalises a subject expression so that the same logical subject can be
 * paired across revisions. Whitespace and trailing non-semantic noise are
 * removed, and `await` is dropped because moving a call to async does not change
 * what is being observed.
 */
export function normaliseSubject(raw: string): string {
  return raw
    .replace(/\bawait\s+/g, "")
    .replace(/\s+/g, "")
    .replace(/;+$/, "");
}

/**
 * A conditional whose branches are all string literals is still a string
 * expectation.
 *
 * From immer: `toThrowError("produce can only be called on drafts")` became
 * `toThrowError(isProd ? "[Immer] minified error nr: 21" : "produce can only …")`
 * when minified error messages were introduced. Classifying the ternary as an
 * opaque expression made it look like the message check had been dropped, and
 * produced four findings on one entirely reasonable commit.
 */
function conditionalOfStrings(node: ts.Node): boolean {
  if (!ts.isConditionalExpression(node)) return false;
  const isStringish = (n: ts.Expression): boolean =>
    ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) || conditionalOfStrings(n);
  return isStringish(node.whenTrue) && isStringish(node.whenFalse);
}

function classifyArgKind(node: ts.Node): AssertionArg["kind"] {
  if (ts.isNumericLiteral(node)) return "number";
  if (ts.isStringLiteralLike(node)) return "string";
  if (conditionalOfStrings(node)) return "string";
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isIdentifier(node) && node.text === "undefined") return "undefined";
  if (ts.isRegularExpressionLiteral(node)) return "regexp";
  if (ts.isObjectLiteralExpression(node)) return "object";
  if (ts.isArrayLiteralExpression(node)) return "array";
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return "identifier";
  if (ts.isCallExpression(node)) return "call";
  // -1 and similar
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return "number";
  return "expression";
}

function toAssertionArg(sf: ts.SourceFile, node: ts.Expression): AssertionArg {
  const raw = textOf(sf, node).trim();
  const kind = classifyArgKind(node);
  const arg: AssertionArg = { raw, kind };
  if (kind === "number") {
    const n = Number(raw);
    if (!Number.isNaN(n)) arg.numeric = n;
  }
  if (kind === "string" && ts.isStringLiteralLike(node)) {
    arg.string = node.text;
  }
  return arg;
}

interface MatcherChain {
  matcher: string;
  negated: boolean;
  async: boolean;
  args: ts.Expression[];
  matcherNode: ts.Node;
}

/**
 * Walks back from an outer call expression to find the `expect(...)` root and
 * the matcher actually applied, handling `.not`, `.resolves`, `.rejects` and
 * chained property access such as `expect(x).not.toBe(1)`.
 */
function unwindExpect(sf: ts.SourceFile, call: ts.CallExpression): { subject: ts.Expression; chain: MatcherChain } | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;

  const matcherName = call.expression.name.text;
  let cursor: ts.Expression = call.expression.expression;
  let negated = false;
  let isAsync = false;

  // Peel modifier properties until we reach the expect() call itself.
  while (ts.isPropertyAccessExpression(cursor)) {
    const prop = cursor.name.text;
    if (prop === "not") negated = !negated;
    else if (prop === "resolves" || prop === "rejects") {
      isAsync = true;
      if (prop === "rejects") {
        // `.rejects.toThrow()` is an error assertion even though the matcher
        // name may be a value matcher; recorded via `async` + matcher name.
      }
    } else if (prop !== "and") {
      // An unexpected property in the chain (e.g. custom matcher namespace).
      // Keep walking; it does not change strength semantics.
    }
    cursor = cursor.expression;
  }

  if (!ts.isCallExpression(cursor)) return undefined;
  const callee = cursor.expression;
  const calleeName = ts.isIdentifier(callee) ? callee.text : undefined;
  if (calleeName !== "expect" && calleeName !== "assert") return undefined;
  const subject = cursor.arguments[0];
  if (!subject) return undefined;

  return {
    subject,
    chain: {
      matcher: matcherName,
      negated,
      async: isAsync,
      args: [...call.arguments],
      matcherNode: call,
    },
  };
}

function collectIdentifiers(sf: ts.SourceFile, node: ts.Node): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...out];
}

function parseAssertionsIn(sf: ts.SourceFile, body: ts.Node): Assertion[] {
  const assertions: Assertion[] = [];

  const visit = (node: ts.Node): void => {
    // Do not descend into nested test() declarations; they are parsed separately.
    if (ts.isCallExpression(node) && isTestCall(node) !== undefined) return;

    if (ts.isCallExpression(node)) {
      const unwound = unwindExpect(sf, node);
      if (unwound) {
        const { subject, chain } = unwound;
        const args = chain.args.map((a) => toAssertionArg(sf, a));
        const cls = classifyMatcher(chain.matcher, args, chain.negated);
        const subjectText = textOf(sf, subject).trim();
        assertions.push({
          line: lineOf(sf, node.getStart(sf)),
          raw: textOf(sf, node).replace(/\s+/g, " ").trim(),
          matcher: chain.matcher,
          negated: chain.negated,
          async: chain.async,
          subject: subjectText,
          subjectKey: normaliseSubject(subjectText),
          args,
          strength: cls.strength,
          aspect: chain.async && chain.matcher.startsWith("toThrow") ? "error" : cls.aspect,
          subjectIdentifiers: collectIdentifiers(sf, subject),
        });
        // An expect() subject can itself contain calls worth scanning, but not
        // further assertions. Stop here.
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(body, visit);
  return assertions;
}

function parseMockOpsIn(sf: ts.SourceFile, body: ts.Node): MockOp[] {
  const ops: MockOp[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const prop = n.expression.name.text;
      const objText = textOf(sf, n.expression.expression);
      if (MOCK_APIS.has(prop)) {
        const api = /^(vi|jest|sinon|td)$/.test(objText) ? `${objText}.${prop}` : prop;
        const op: MockOp = {
          line: lineOf(sf, n.getStart(sf)),
          raw: textOf(sf, n).replace(/\s+/g, " ").trim().slice(0, 200),
          api,
        };
        const first = n.arguments[0];
        if ((prop === "mock" || prop === "doMock") && first && ts.isStringLiteralLike(first)) {
          op.moduleTarget = first.text;
        }
        ops.push(op);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return ops;
}

function parseImplicitAssertionsIn(sf: ts.SourceFile, body: ts.Node): ImplicitAssertion[] {
  const out: ImplicitAssertion[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name =
        ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
        : undefined;
      if (name && isImplicitAssertionName(name)) {
        out.push({
          line: lineOf(sf, n.getStart(sf)),
          api: name,
          raw: textOf(sf, n).replace(/\s+/g, " ").trim().slice(0, 160),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

function collectCalls(sf: ts.SourceFile, body: ts.Node): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text !== "expect" && !TEST_FNS.has(callee.text) && !SUITE_FNS.has(callee.text)) {
          out.add(callee.text);
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        const text = textOf(sf, callee).replace(/\s+/g, "");
        // Skip the assertion machinery itself: `expect(x).toBe` is not a call
        // into the code under test, and listing it in the report reads as noise.
        if (!/^(expect|vi|jest|sinon|assert)\b/.test(text)) out.add(text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return [...out];
}

interface TestCallInfo {
  kind: "test" | "suite";
  base: string;
  modifier: TestModifier;
  title?: string;
  body?: ts.Node;
}

function isTestCall(node: ts.CallExpression): TestCallInfo | undefined {
  let base: string | undefined;
  let modifier: TestModifier = "none";
  const expr = node.expression;

  if (ts.isIdentifier(expr)) {
    base = expr.text;
  } else if (ts.isPropertyAccessExpression(expr)) {
    const prop = expr.name.text;
    // test.skip / it.each(...)  / describe.only
    let root: ts.Expression = expr.expression;
    // handle it.each`table`(...) and it.each([...])(...)
    if (ts.isCallExpression(root)) root = root.expression;
    if (ts.isTaggedTemplateExpression(root)) root = root.tag;
    if (ts.isPropertyAccessExpression(root)) {
      // e.g. it.concurrent.skip
      if (root.name.text === "skip") modifier = "skip";
      root = root.expression;
    }
    if (ts.isIdentifier(root)) base = root.text;
    if (prop === "skip") modifier = "skip";
    else if (prop === "todo") modifier = "todo";
    else if (prop === "only") modifier = "only";
    else if (prop === "failing") modifier = "failing";
  } else if (ts.isCallExpression(expr)) {
    // it.each([...])('name', fn)
    const inner = expr.expression;
    if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
      base = inner.expression.text;
      if (inner.name.text === "skip") modifier = "skip";
    }
  } else if (ts.isTaggedTemplateExpression(expr)) {
    const tag = expr.tag;
    if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
      base = tag.expression.text;
    }
  }

  if (!base) return undefined;

  const isTest = TEST_FNS.has(base);
  const isSuite = SUITE_FNS.has(base);
  if (!isTest && !isSuite) return undefined;

  // xit / xtest / xdescribe are skip forms.
  if (base.startsWith("x")) modifier = "skip";
  if (base === "fit" || base === "fdescribe") modifier = "only";

  const titleArg = node.arguments[0];
  const title =
    titleArg && ts.isStringLiteralLike(titleArg)
      ? titleArg.text
      : titleArg && ts.isTemplateExpression(titleArg)
        ? titleArg.getText().replace(/[`]/g, "")
        : titleArg
          ? titleArg.getText().slice(0, 80)
          : undefined;

  const fnArg = node.arguments.find((a) => ts.isFunctionExpression(a) || ts.isArrowFunction(a));

  return {
    kind: isTest ? "test" : "suite",
    base,
    modifier,
    title,
    body: fnArg,
  };
}

/**
 * Assertion libraries whose API TestSlop does not model.
 *
 * This matters more than it looks. Scanning ky produced zero findings across 100
 * commits, which reads like a clean bill of health. In fact ky uses ava, whose
 * assertions are `t.is(...)` / `t.like(...)`, so 256 test cases were parsed and
 * *not one assertion was analysed*. A tool that silently analyses nothing is
 * worse than one that errors, so unsupported files are recorded as problems and
 * surfaced in the report.
 */
const UNSUPPORTED_ASSERTION_LIBS: Array<{ specifier: RegExp; name: string }> = [
  { specifier: /^ava$/, name: "ava (t.is / t.like / t.throwsAsync)" },
  { specifier: /^chai$/, name: "chai (expect(x).to.equal)" },
  { specifier: /^should$/, name: "should.js" },
  { specifier: /^(node:)?assert(\/strict)?$/, name: "node:assert" },
  { specifier: /^tape$/, name: "tape" },
  { specifier: /^@japa\//, name: "japa" },
];

function detectFramework(content: string, imports: ImportRecord[]): Framework {
  if (imports.some((i) => i.specifier === "vitest")) return "vitest";
  if (imports.some((i) => i.specifier === "@jest/globals")) return "jest";
  if (imports.some((i) => i.specifier === "ava")) return "ava";
  if (imports.some((i) => i.specifier === "node:test" || i.specifier === "test")) return "node:test";
  if (/\bvi\s*\./.test(content)) return "vitest";
  if (/\bjest\s*\./.test(content)) return "jest";
  if (/\b(describe|it|test)\s*\(/.test(content)) return "jest";
  return "unknown";
}

function unsupportedAssertionLibrary(imports: ImportRecord[]): string | undefined {
  for (const imp of imports) {
    for (const lib of UNSUPPORTED_ASSERTION_LIBS) {
      if (lib.specifier.test(imp.specifier)) return lib.name;
    }
  }
  return undefined;
}

function parseImports(sf: ts.SourceFile): ImportRecord[] {
  const out: ImportRecord[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const names: string[] = [];
      const clause = stmt.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) names.push(el.name.text);
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(clause.namedBindings.name.text);
        }
      }
      out.push({
        specifier: stmt.moduleSpecifier.text,
        names,
        line: lineOf(sf, stmt.getStart(sf)),
      });
    }
  }
  // CommonJS require()
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "require" &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push({
        specifier: (n.arguments[0] as ts.StringLiteral).text,
        names: [],
        line: lineOf(sf, n.getStart(sf)),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function parseTestFile(filePath: string, content: string): TestFileModel {
  const problems: string[] = [];
  let sf: ts.SourceFile;
  try {
    sf = createSourceFile(filePath, content);
  } catch (err) {
    return {
      path: filePath,
      framework: "unknown",
      cases: [],
      imports: [],
      moduleMocks: [],
      problems: [`parse failed: ${(err as Error).message}`],
    };
  }

  const imports = parseImports(sf);
  const cases: TestCase[] = [];
  const moduleMocks: MockOp[] = [];

  // Module-level mocks are hoisted and apply to every test in the file, so they
  // are collected separately from per-test mock operations.
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const ops = parseMockOpsIn(sf, stmt.expression);
      for (const op of ops) {
        if (op.api === "vi.mock" || op.api === "jest.mock" || op.api === "vi.doMock" || op.api === "jest.doMock") {
          moduleMocks.push(op);
        }
      }
    }
  }

  const walk = (node: ts.Node, suitePath: string[], inheritedModifier: TestModifier): void => {
    if (ts.isCallExpression(node)) {
      const info = isTestCall(node);
      if (info) {
        const effectiveModifier =
          info.modifier !== "none" ? info.modifier
          : inheritedModifier !== "none" ? inheritedModifier
          : "none";

        if (info.kind === "suite") {
          const nextPath = info.title ? [...suitePath, info.title] : suitePath;
          if (info.body) {
            ts.forEachChild(info.body, (child) => walk(child, nextPath, effectiveModifier));
          }
          return;
        }

        const name = info.title ?? "<dynamic title>";
        const bodyNode = info.body;
        const start = lineOf(sf, node.getStart(sf));
        const end = lineOf(sf, node.getEnd());
        const assertions = bodyNode ? parseAssertionsIn(sf, bodyNode) : [];
        const implicitAssertions = bodyNode ? parseImplicitAssertionsIn(sf, bodyNode) : [];
        const bodyText = bodyNode ? textOf(sf, bodyNode) : "";
        cases.push({
          name,
          fullName: [...suitePath, name].join(" > "),
          line: start,
          endLine: end,
          modifier: effectiveModifier,
          assertions,
          body: bodyText,
          calls: bodyNode ? collectCalls(sf, bodyNode) : [],
          mockOps: bodyNode ? parseMockOpsIn(sf, bodyNode) : [],
          hasNoAssertions: assertions.length === 0 && implicitAssertions.length === 0,
          implicitAssertions,
        });
        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, suitePath, inheritedModifier));
  };

  ts.forEachChild(sf, (node) => walk(node, [], "none"));

  if (cases.length === 0 && /\b(it|test)\s*[.(]/.test(content)) {
    problems.push("file looks like a test file but no test cases were extracted");
  }

  // Cases parsed but no assertions found anywhere: the oracle was not analysed.
  // Say so, rather than letting an empty result imply a clean verdict.
  const totalAssertions = cases.reduce((n, c) => n + c.assertions.length + c.implicitAssertions.length, 0);
  if (cases.length > 0 && totalAssertions === 0) {
    const lib = unsupportedAssertionLibrary(imports);
    problems.push(
      lib
        ? `${cases.length} test case(s) parsed but no assertions recognised: this file uses ${lib}, which TestSlop does not model. Oracle-strength rules did not run on it.`
        : `${cases.length} test case(s) parsed but no assertions recognised. Oracle-strength rules did not run on this file.`,
    );
  }

  return {
    path: filePath,
    framework: detectFramework(content, imports),
    cases,
    imports,
    moduleMocks,
    problems,
  };
}
