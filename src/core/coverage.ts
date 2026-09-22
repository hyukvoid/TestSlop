/**
 * Analysis coverage.
 *
 * The failure mode this exists to prevent was found in POC-00 and confirmed in
 * POC-01's survey: TestSlop can parse hundreds of test cases and analyse zero
 * assertions, and the report then looks identical to a genuinely clean scan.
 *
 *   256 tests parsed, 0 supported assertions   ->  "no problems found"
 *
 * That is the worst possible output for a tool whose job is to tell you whether to
 * trust your suite. Coverage is therefore computed explicitly and reported
 * alongside the findings, with a warning whenever oracle analysis did not actually
 * run on part of the changeset.
 */

import type { AnalysisContext, Framework } from "./types.ts";

export interface FileCoverage {
  file: string;
  framework: Framework;
  testsDiscovered: number;
  assertionsRecognised: number;
  /** Assertions that verify by throwing rather than through expect(). */
  implicitAssertions: number;
  /** Populated when this file's oracle could not be analysed. */
  problem?: string;
}

export interface AnalysisCoverage {
  files: FileCoverage[];
  testFilesChanged: number;
  testsDiscovered: number;
  testsAnalysed: number;
  assertionsRecognised: number;
  /** Files with test cases but no recognisable assertion of any kind. */
  unanalysedFiles: FileCoverage[];
  /** Distinct frameworks seen, for the report header. */
  frameworks: Framework[];
  /**
   * True when every changed test file yielded at least one assertion. When false
   * the reporter must not present an empty finding list as a clean result.
   */
  complete: boolean;
}

export function computeCoverage(ctx: AnalysisContext): AnalysisCoverage {
  const files: FileCoverage[] = [];

  for (const entry of ctx.tests) {
    const model = entry.after ?? entry.before;
    if (!model) continue;

    const testsDiscovered = model.cases.length;
    const assertionsRecognised = model.cases.reduce((n, c) => n + c.assertions.length, 0);
    const implicitAssertions = model.cases.reduce((n, c) => n + c.implicitAssertions.length, 0);

    const fc: FileCoverage = {
      file: entry.file.path,
      framework: model.framework,
      testsDiscovered,
      assertionsRecognised,
      implicitAssertions,
    };
    const problem = model.problems[0];
    if (problem) fc.problem = problem;
    files.push(fc);
  }

  const unanalysedFiles = files.filter(
    (f) => f.testsDiscovered > 0 && f.assertionsRecognised === 0 && f.implicitAssertions === 0,
  );

  const testsAnalysed = files
    .filter((f) => f.assertionsRecognised > 0 || f.implicitAssertions > 0)
    .reduce((n, f) => n + f.testsDiscovered, 0);

  return {
    files,
    testFilesChanged: files.length,
    testsDiscovered: files.reduce((n, f) => n + f.testsDiscovered, 0),
    testsAnalysed,
    assertionsRecognised: files.reduce((n, f) => n + f.assertionsRecognised, 0),
    unanalysedFiles,
    frameworks: [...new Set(files.map((f) => f.framework))],
    complete: unanalysedFiles.length === 0,
  };
}
