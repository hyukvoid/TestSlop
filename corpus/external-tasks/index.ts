/**
 * POC-02 external-repository agent tasks.
 *
 * Goal C: exercise the changed-behaviour hypothesis on codebases the TestSlop author
 * did not write. POC-01's benchmark used an authored service, which was its second
 * largest threat to validity after single-agent dependence.
 *
 * Repository selection criteria, fixed before any task was written:
 *   - real, widely used, not chosen because it suits TestSlop
 *   - understandable domain logic with genuine boundary behaviour
 *   - test suite that installs and runs in seconds
 *   - a runner TestSlop can drive and filter by file
 *
 * Task selection: ordinary change requests of the kind these projects actually receive,
 * phrased as a maintainer would phrase them. **No task mentions boundaries, edge cases,
 * test quality or assertions.** The point is to observe what the agent tests when nobody
 * tells it what to test.
 *
 * `prior` is pre-registered, as in POC-01.
 */

export interface ExternalTask {
  id: string;
  /** Directory under work/ext. */
  repo: string;
  /** Upstream, for the record. */
  origin: string;
  runner: "mocha" | "jest" | "vitest";
  category: "feature" | "bug-fix" | "validation" | "behaviour-change";
  prompt: string;
  prior: "expect-clean" | "expect-risk" | "uncertain";
  priorReason: string;
}

export const EXTERNAL_TASKS: ExternalTask[] = [
  // --- bytes.js: byte-size parsing and formatting -------------------------
  {
    id: "X01-bytes-tebibyte",
    repo: "bytes",
    origin: "https://github.com/visionmedia/bytes.js",
    runner: "mocha",
    category: "feature",
    prompt:
      "Please add support for pebibytes to this library, so that bytes('1pb') parses and " +
      "bytes(1125899906842624) formats as '1PB'. Follow the existing pattern for the other " +
      "units and update the tests.",
    prior: "uncertain",
    priorReason:
      "Additive and pattern-following. The interesting question is whether the agent tests the threshold at which formatting switches from TB to PB.",
  },
  {
    id: "X02-bytes-negative",
    repo: "bytes",
    origin: "https://github.com/visionmedia/bytes.js",
    runner: "mocha",
    category: "bug-fix",
    prompt:
      "Bug report: bytes.format(-1024) returns '-1KB' but bytes.parse('-1KB') returns null, " +
      "so a formatted value cannot be round-tripped. Please make parse accept a leading " +
      "minus sign and update the tests.",
    prior: "expect-risk",
    priorReason:
      "Sign handling has obvious boundaries at zero and at the smallest magnitude. A fix that only tests '-1KB' would leave several unconstrained.",
  },
  {
    id: "X03-bytes-decimal-places",
    repo: "bytes",
    origin: "https://github.com/visionmedia/bytes.js",
    runner: "mocha",
    category: "behaviour-change",
    prompt:
      "The decimalPlaces option currently applies even when the value is a whole number, " +
      "so format(1024, { decimalPlaces: 2 }) gives '1.00KB'. Users have asked for a " +
      "trailing-zero suppression option: add { trailingZeroes: false } which strips " +
      "trailing zeroes from the fraction. Default behaviour must not change. Update the tests.",
    prior: "expect-risk",
    priorReason:
      "A formatting option with several interacting branches; easy to test the headline case and miss the interactions.",
  },

  // --- ms: human-readable time string parsing and formatting --------------
  // validator.js was the first choice and was dropped: its test suite requires
  // `npm run build` to produce the bundle the tests import, which the agent would have
  // to reproduce and which makes a failed build indistinguishable from a failed task.
  {
    id: "X04-ms-weeks",
    repo: "ms",
    origin: "https://github.com/vercel/ms",
    runner: "jest",
    category: "feature",
    prompt:
      "Please add support for a 'fortnight' unit, so ms('1 fortnight') parses to two " +
      "weeks in milliseconds and the usual abbreviations work the way the other units do. " +
      "Update the tests.",
    prior: "uncertain",
    priorReason:
      "Additive and pattern-following. The question is whether the agent covers the abbreviation and plural forms or only the headline string.",
  },
  {
    id: "X05-ms-rounding",
    repo: "ms",
    origin: "https://github.com/vercel/ms",
    runner: "jest",
    category: "behaviour-change",
    prompt:
      "The long format rounds so that 1.5 days prints as '2 days', which surprises people " +
      "reading logs. Please change the long format to truncate rather than round, so " +
      "1.5 days prints as '1 day'. Keep the short format as it is, and update the tests.",
    prior: "expect-risk",
    priorReason:
      "Rounding and pluralisation interact at exactly the values a test suite tends to skip: 1.0, 1.5, and just under 2.",
  },
  {
    id: "X06-ms-negative-long",
    repo: "ms",
    origin: "https://github.com/vercel/ms",
    runner: "jest",
    category: "bug-fix",
    prompt:
      "Bug: ms(-1500, { long: true }) returns '-2 seconds' but ms(-1000, { long: true }) " +
      "returns '-1 second', so the plural form is chosen from the rounded magnitude in one " +
      "case and not the other. Please make negative durations consistent with positive " +
      "ones and extend the tests.",
    prior: "expect-risk",
    priorReason:
      "Sign plus pluralisation plus rounding. Three interacting boundaries, and the report only names one of them.",
  },
];

export function externalTaskById(id: string): ExternalTask | undefined {
  return EXTERNAL_TASKS.find((t) => t.id === id);
}
