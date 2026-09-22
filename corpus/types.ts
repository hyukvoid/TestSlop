/**
 * Evaluation corpus format.
 *
 * Every case is materialised as a *real two-commit git repository*, not an
 * in-memory pair of strings. That is deliberate: the change collector, the
 * merge-base logic, the unified-diff line mapping and the rename handling are
 * all part of what is being evaluated, and synthetic diffs would skip them.
 *
 * `expect` is the ground truth a human assigned by reading the diff, written
 * before looking at what TestSlop reports. The harness scores against it.
 */

export type Category =
  /** A: deliberately degraded oracle. TestSlop should find the listed rules. */
  | "A"
  /** B: clean change that superficially resembles a Category A pattern. */
  | "B"
  /** C: real-world repository history. */
  | "C"
  /** D: change produced by a coding agent working from a task description. */
  | "D";

export interface CaseExpectation {
  /**
   * Rules that must fire for the case to count as detected. Ground truth,
   * assigned by reading the diff.
   */
  rules: string[];
  /**
   * Rules that must NOT fire. Anything reported here counts as a false positive
   * in the metrics. For Category B this is usually "every rule".
   */
  forbidden?: string[];
  /**
   * Findings that are defensible but noisy. Not scored as true positives and not
   * scored as false positives; counted separately as "acceptable noise" so the
   * report can be honest about the grey zone rather than hiding it.
   */
  tolerated?: string[];
}

export interface CorpusCase {
  id: string;
  category: Category;
  /** What a reviewer should conclude, in one sentence. */
  intent: string;
  /** The task a developer or agent was nominally working on. */
  task: string;
  /** Files at the base commit. Keys are repo-relative POSIX paths. */
  base: Record<string, string>;
  /**
   * Files at the head commit. Only differences from `base` need listing; a value
   * of `null` deletes the file.
   */
  change: Record<string, string | null>;
  expect: CaseExpectation;
  /** Set when the case is designed to be verified by targeted mutation. */
  mutation?: {
    /** Expect at least one surviving mutant. */
    expectSurvivor: boolean;
    note: string;
  };
  /** Extra files to write but not commit at base (e.g. package.json). */
  scaffold?: Record<string, string>;
}

/** package.json shared by generated TypeScript corpus repositories. */
export function tsScaffold(name: string): Record<string, string> {
  return {
    "package.json": JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        devDependencies: { vitest: "3.2.4" },
      },
      null,
      2,
    ),
    "vitest.config.ts": [
      'import { defineConfig } from "vitest/config";',
      "",
      "export default defineConfig({",
      '  test: { include: ["**/*.test.ts"], environment: "node" },',
      "});",
      "",
    ].join("\n"),
  };
}
