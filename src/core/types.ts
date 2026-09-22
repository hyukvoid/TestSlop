/**
 * Core data model shared by the change collector, the language adapters, the
 * rule engine and the reporters.
 *
 * Design note: nothing in here is TypeScript/Jest specific. Adapters are
 * responsible for lowering a concrete test framework into these shapes, so that
 * rules can be written once against a normalised model. That boundary is the
 * main thing keeping a future pytest/JUnit adapter tractable.
 */

// ---------------------------------------------------------------------------
// Change collection
// ---------------------------------------------------------------------------

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export type FileRole = "test" | "production" | "other";

export interface ChangedFile {
  /** Repo-relative POSIX path of the file after the change. */
  path: string;
  /** Previous path when the file was renamed. */
  oldPath?: string;
  status: FileStatus;
  role: FileRole;
  /** Full content at the base revision. `undefined` for added files. */
  before?: string;
  /** Full content at the head revision. `undefined` for deleted files. */
  after?: string;
  /** 1-based line numbers touched in the `before` version (removed lines). */
  removedLines: number[];
  /** 1-based line numbers touched in the `after` version (added lines). */
  addedLines: number[];
}

export interface ChangeSet {
  repoRoot: string;
  /** Human description of what was compared, e.g. "main...worktree". */
  range: string;
  baseRef: string;
  headRef: string;
  files: ChangedFile[];
}

// ---------------------------------------------------------------------------
// Assertion strength lattice
// ---------------------------------------------------------------------------

/**
 * Assertion strength is modelled as the size of the set of program behaviours
 * an assertion still accepts. A *weaker* assertion admits more behaviour, and
 * therefore detects fewer regressions.
 *
 * This is deliberately an ordinal scale over *specificity classes* rather than
 * a heuristic score, because the only comparison TestSlop ever needs is
 * "did this assertion start accepting strictly more behaviour than before?".
 *
 * Ordering (strong -> weak):
 *
 *   EXACT        admits exactly one value                 expect(x).toBe(401)
 *   STRUCTURAL   pins part of a value's shape             toMatchObject({a:1})
 *   CONSTRAINED  restricts to a range/pattern             toBeGreaterThan(0)
 *   TYPE_ONLY    restricts to a type                      toBeInstanceOf(Error)
 *   EXISTENCE    only rules out absence/falsiness         toBeDefined()
 *   OPAQUE       runs but pins nothing reviewable         toMatchSnapshot()
 *   VACUOUS      cannot fail for the subject              not.toBe(<other>)
 *   NONE         no assertion at all
 */
export const STRENGTH_ORDER = [
  "NONE",
  "VACUOUS",
  "OPAQUE",
  "EXISTENCE",
  "TYPE_ONLY",
  "CONSTRAINED",
  "STRUCTURAL",
  "EXACT",
] as const;

export type StrengthClass = (typeof STRENGTH_ORDER)[number];

export function strengthRank(cls: StrengthClass): number {
  return STRENGTH_ORDER.indexOf(cls);
}

/** What the assertion is fundamentally checking. */
export type AssertionAspect =
  | "value" // an observable value or state
  | "interaction" // that a collaborator was called
  | "error" // that something threw / rejected
  | "snapshot" // serialised blob comparison
  | "unknown";

export interface AssertionArg {
  raw: string;
  /** Present when the argument is a literal we can reason about numerically. */
  numeric?: number;
  /** Present when the argument is a string literal. */
  string?: string;
  kind:
    | "number"
    | "string"
    | "boolean"
    | "null"
    | "undefined"
    | "regexp"
    | "object"
    | "array"
    | "identifier"
    | "call"
    | "expression"
    | "none";
}

export interface Assertion {
  /** 1-based line in the file this assertion was parsed from. */
  line: number;
  /** Source text of the whole assertion statement, trimmed. */
  raw: string;
  /** Matcher name, e.g. "toBe", "toHaveBeenCalledWith". */
  matcher: string;
  /** Whether `.not` appears in the matcher chain. */
  negated: boolean;
  /** Whether `.resolves`/`.rejects` appears in the chain. */
  async: boolean;
  /** Source text of the expression passed to expect(...), normalised. */
  subject: string;
  /** Normalised subject used for before/after pairing. */
  subjectKey: string;
  args: AssertionArg[];
  strength: StrengthClass;
  aspect: AssertionAspect;
  /**
   * Identifiers referenced by the subject expression. Used to decide whether an
   * assertion observes the system under test or only a mock.
   */
  subjectIdentifiers: string[];
}

// ---------------------------------------------------------------------------
// Test model
// ---------------------------------------------------------------------------

export type TestModifier = "none" | "skip" | "todo" | "only" | "failing";

export interface TestCase {
  /** The literal test title. */
  name: string;
  /** describe() titles + test title, joined with " > ". */
  fullName: string;
  line: number;
  endLine: number;
  modifier: TestModifier;
  assertions: Assertion[];
  /** Source text of the test body, used for cheap textual heuristics. */
  body: string;
  /** Identifiers of things the body calls, excluding assertion machinery. */
  calls: string[];
  /** Mock/stub creation and configuration operations found in the body. */
  mockOps: MockOp[];
  /** True when the body contains no `expect`-like call at all. */
  hasNoAssertions: boolean;
}

export interface MockOp {
  line: number;
  raw: string;
  /** e.g. "vi.mock", "jest.fn", "mockResolvedValue", "spyOn". */
  api: string;
  /** Module path for module-level mocks, when statically known. */
  moduleTarget?: string;
}

export interface TestFileModel {
  path: string;
  framework: Framework;
  cases: TestCase[];
  /** Module specifiers imported by the file. */
  imports: ImportRecord[];
  /** Module-level mock declarations (vi.mock / jest.mock). */
  moduleMocks: MockOp[];
  /** Parse diagnostics; a non-empty list means the model may be incomplete. */
  problems: string[];
}

export interface ImportRecord {
  specifier: string;
  names: string[];
  line: number;
  /** Repo-relative resolved path, when the specifier is relative. */
  resolved?: string;
}

export type Framework = "jest" | "vitest" | "node:test" | "pytest" | "unknown";

// ---------------------------------------------------------------------------
// Production-side model
// ---------------------------------------------------------------------------

/**
 * Value-bearing tokens extracted from a production file. Comparing these
 * between base and head is what lets TestSlop notice that an implementation
 * constant moved at the same time as a test expectation.
 */
export interface ProductionSignal {
  line: number;
  kind:
    | "numeric-literal"
    | "string-literal"
    | "boolean-literal"
    | "comparison-operator"
    | "logical-operator"
    | "arithmetic-operator"
    | "return-expression"
    | "conditional"
    | "throw"
    | "coverage-ignore"
    | "test-environment-branch";
  text: string;
  numeric?: number;
  /** Enclosing function name, when determinable. */
  enclosing?: string;
}

export interface ProductionFileModel {
  path: string;
  signals: ProductionSignal[];
  exportedNames: string[];
  /** Function name -> source text of its return expressions. */
  returnExpressions: Map<string, string[]>;
  problems: string[];
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type Severity = "high" | "medium" | "low";

/**
 * `review` findings are judgement calls surfaced for a human. `evidence`
 * findings are backed by an executed experiment (currently: targeted mutation)
 * and make a factual claim about behaviour.
 *
 * TestSlop deliberately has no `error` class in POC-00: static analysis of a
 * diff cannot prove a test is wrong, and claiming otherwise is how tools like
 * this lose trust.
 */
export type FindingClass = "review" | "evidence";

export interface EvidenceBlock {
  label: string;
  before?: string;
  after?: string;
  detail?: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  class: FindingClass;
  /** Rough precision expectation for this detector, 0..1. Documented per rule. */
  confidence: number;
  file: string;
  line: number;
  productionFile?: string;
  productionLine?: number;
  testName?: string;
  message: string;
  /** One sentence on why this matters, shown under the message. */
  rationale?: string;
  evidence: EvidenceBlock[];
}

// ---------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------

export interface AnalysedTestFile {
  file: ChangedFile;
  before?: TestFileModel;
  after?: TestFileModel;
}

export interface AnalysedProductionFile {
  file: ChangedFile;
  before?: ProductionFileModel;
  after?: ProductionFileModel;
}

export interface AnalysisContext {
  changeSet: ChangeSet;
  tests: AnalysedTestFile[];
  production: AnalysedProductionFile[];
  /** test path -> production paths it imports (repo-relative). */
  testToProduction: Map<string, string[]>;
}

export interface Rule {
  id: string;
  /** One-line description used by `testslop rules`. */
  title: string;
  /** Why an existing linter cannot report this. */
  uniqueness: string;
  defaultSeverity: Severity;
  /** Documented precision expectation, informs `confidence`. */
  baseConfidence: number;
  /** True when the rule fundamentally needs before/after state. */
  diffAware: boolean;
  run(ctx: AnalysisContext): Finding[];
}

export interface ScanSummary {
  testFilesChanged: number;
  productionFilesChanged: number;
  testCasesChanged: number;
  findings: number;
  durationMs: number;
  mutationDurationMs?: number;
}

export interface ScanResult {
  summary: ScanSummary;
  findings: Finding[];
  range: string;
}
