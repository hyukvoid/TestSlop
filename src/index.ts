/**
 * Programmatic entry point.
 *
 * Exported so the evaluation harness (and, later, a GitHub Action or an agent
 * integration) can drive the analyser without going through the CLI.
 */

export type {
  AnalysisContext,
  Assertion,
  ChangeSet,
  ChangedFile,
  Finding,
  ProductionFileModel,
  Rule,
  ScanResult,
  StrengthClass,
  TestCase,
  TestFileModel,
} from "./core/types.ts";
export { STRENGTH_ORDER, strengthRank } from "./core/types.ts";

export { collectChangeSet, syntheticChangeSet, classifyPath } from "./core/changeset.ts";
export { analyse, buildContext, runRules, sortFindings, countChangedTestCases } from "./core/pipeline.ts";
export { ALL_RULES, rulesByIds, excludeRules } from "./rules/index.ts";

export { parseTestFile } from "./adapters/ts/parse-test.ts";
export { parseProductionFile } from "./adapters/ts/parse-production.ts";
export { classifyMatcher, isInteractionMatcher, isSnapshotMatcher } from "./adapters/ts/strength.ts";
export { parsePythonTestFile, parsePythonProductionFile, pythonAvailable } from "./adapters/python/index.ts";

export { renderReport, renderFinding, renderRuleList } from "./report/human.ts";
export { toJsonReport, SCHEMA_VERSION } from "./report/json.ts";

export {
  runMutationExperiment,
  runMutationVerification,
  mutationFindings,
  summariseMutation,
  detectTestCommand,
} from "./mutation/verify.ts";
export { generateMutants, applyMutant } from "./mutation/mutators.ts";
export type { Mutant } from "./mutation/mutators.ts";
export type { MutationRunReport, MutantOutcome } from "./mutation/verify.ts";
