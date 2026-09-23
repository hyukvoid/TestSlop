/**
 * Empirical equivalent-mutant taxonomy.
 *
 * Built by re-examining all 19 surviving mutants from the POC-01 independent-agent
 * benchmark, one at a time, against the actual source. Not derived from theory.
 *
 * POC-01 reported "~26% equivalent mutants" and treated that as one problem. It is
 * not. The 19 survivors decompose into six categories with **four different fixes**,
 * and only two of the nineteen are equivalent in the strict sense.
 *
 * This file is the input to POC-02's suppression design, and the regression corpus
 * for it: `test/equivalence.test.ts` asserts that each entry is handled the way the
 * taxonomy says it should be.
 */

export type EquivalenceCategory =
  /** Real gap: original and mutant differ on an input the tests never supply. */
  | "untested-input-class"
  /** Same behavioural gap as another survivor, expressed by a different edit. */
  | "redundant"
  /** Differ only for inputs the domain cannot produce (HTTP status 600). */
  | "out-of-domain-input"
  /** Differ only in state or output the module's contract does not expose. */
  | "out-of-contract-observation"
  /** No observable difference at any input. True equivalence. */
  | "provably-equivalent"
  /** Real difference, but the mutated site is an implementation detail and the
   *  finding does not communicate the actual gap to a developer. */
  | "oblique";

export type Fix =
  | "keep"                    // this is the product working
  | "group-by-distinguishing-input"
  | "reachability-of-distinguishing-input"
  | "differential-execution"
  | "observability-analysis"
  | "better-mutation-targeting";

export interface TaxonomyEntry {
  task: string;
  file: string;
  line: number;
  code: string;
  mutation: string;
  operator: string;
  category: EquivalenceCategory;
  /** The input on which original and mutant differ, in developer language. */
  distinguishingInput: string;
  reasoning: string;
  fix: Fix;
}

export const TAXONOMY: TaxonomyEntry[] = [
  // --- untested-input-class: the product working as intended -----------------
  {
    task: "T09-reject-nonpositive-reservation",
    file: "src/inventory.ts",
    line: 34,
    code: "if (!Number.isInteger(quantity) || quantity <= 0) {",
    mutation: "0 -> 1",
    operator: "constant",
    category: "untested-input-class",
    distinguishingInput: "quantity = 1",
    reasoning:
      "The agent tested 0, -1, 1.5, NaN and Infinity but never 1, the smallest valid quantity. The mutant rejects every quantity-1 reservation and the suite stays green.",
    fix: "keep",
  },
  {
    task: "T15-webhook-replay-protection",
    file: "src/webhooks.ts",
    line: 40,
    code: "if (now - timestamp > TOLERANCE_SECONDS) {",
    mutation: "> -> >=",
    operator: "boundary",
    category: "untested-input-class",
    distinguishingInput: "now - timestamp = TOLERANCE_SECONDS exactly",
    reasoning: "An off-by-one on a replay-protection window. Nothing exercises the exact tolerance.",
    fix: "keep",
  },
  {
    task: "T18-atomic-reserve-many",
    file: "src/inventory.ts",
    line: 61,
    code: "if (item.quantity > avail) {",
    mutation: "> -> >=",
    operator: "boundary",
    category: "untested-input-class",
    distinguishingInput: "item.quantity = avail exactly",
    reasoning: "Reserving exactly the available stock is the interesting case and is untested.",
    fix: "keep",
  },
  {
    task: "T18-atomic-reserve-many",
    file: "src/inventory.ts",
    line: 64,
    code: "remaining.set(item.sku, avail - item.quantity);",
    mutation: "- -> +",
    operator: "arithmetic",
    category: "untested-input-class",
    distinguishingInput: "two lines for the same SKU in one reserveMany call",
    reasoning:
      "The running-availability bookkeeping only matters when one call touches the same SKU twice, which no test does. The best survivor in the benchmark after T09.",
    fix: "keep",
  },
  {
    task: "T17-money-allocate",
    file: "src/money.ts",
    line: 56,
    code: "if (ratio > 0) {",
    mutation: "> -> >=",
    operator: "boundary",
    category: "untested-input-class",
    distinguishingInput: "a ratio of 0",
    reasoning: "Zero ratios are never passed, so their handling is unverified.",
    fix: "keep",
  },
  {
    task: "T17-money-allocate",
    file: "src/money.ts",
    line: 37,
    code: "if (ratios.length === 0) {",
    mutation: "0 -> 1",
    operator: "constant",
    category: "untested-input-class",
    distinguishingInput: "a single-element ratio list",
    reasoning: "allocate() is never called with exactly one ratio.",
    fix: "keep",
  },
  {
    task: "T20-pagination-reject-bad-page",
    file: "src/pagination.ts",
    line: 25,
    code: "if (raw.size !== undefined && raw.size < 1) {",
    mutation: "< -> <=",
    operator: "boundary",
    category: "untested-input-class",
    distinguishingInput: "size = 1",
    reasoning: "The smallest valid page size is never requested, so the accept/reject boundary is unpinned.",
    fix: "keep",
  },
  {
    task: "T07-bankers-rounding",
    file: "src/money.ts",
    line: 62,
    code: "if (fraction > 0.5) {",
    mutation: "0.5 -> 1.5",
    operator: "constant",
    category: "untested-input-class",
    distinguishingInput: "a fractional cent strictly between 0.5 and 1",
    reasoning:
      "Every rounding test uses a fraction of exactly 0 or exactly 0.5, so the ordinary round-up path is never taken.",
    fix: "keep",
  },

  // --- redundant: one gap, several edits ------------------------------------
  {
    task: "T07-bankers-rounding",
    file: "src/money.ts",
    line: 63,
    code: "return lower + 1;",
    mutation: "1 -> 2",
    operator: "constant",
    category: "redundant",
    distinguishingInput: "a fractional cent strictly between 0.5 and 1",
    reasoning:
      "Reachable only through the `fraction > 0.5` branch, so it describes exactly the same missing input class as the survivor above. Reporting it separately triples the noise for one gap.",
    fix: "group-by-distinguishing-input",
  },
  {
    task: "T07-bankers-rounding",
    file: "src/money.ts",
    line: 63,
    code: "return lower + 1;",
    mutation: "+ -> -",
    operator: "arithmetic",
    category: "redundant",
    distinguishingInput: "a fractional cent strictly between 0.5 and 1",
    reasoning: "Third expression of the same gap.",
    fix: "group-by-distinguishing-input",
  },
  {
    task: "T20-pagination-reject-bad-page",
    file: "src/pagination.ts",
    line: 25,
    code: "if (raw.size !== undefined && raw.size < 1) {",
    mutation: "1 -> 2",
    operator: "constant",
    category: "redundant",
    distinguishingInput: "size = 1",
    reasoning:
      "`size < 2` and `size <= 1` are the same predicate. Shifting the threshold and relaxing the operator produce an identical distinguishing input, so these must be one finding.",
    fix: "group-by-distinguishing-input",
  },
  {
    task: "T14-gb-postcode-no-space",
    file: "src/address.ts",
    line: 27,
    code: "return withoutSpaces.length > 3",
    mutation: "3 -> 4",
    operator: "constant",
    category: "redundant",
    distinguishingInput: "a postcode of exactly 4 characters after removing spaces",
    reasoning: "Same threshold as the boundary mutant on the same line, shifted instead of relaxed.",
    fix: "group-by-distinguishing-input",
  },

  // --- out-of-domain-input --------------------------------------------------
  {
    task: "T22-retry-more-statuses",
    file: "src/retry.ts",
    line: 30,
    code: "return status >= 500 && status < 600 && status !== 501;",
    mutation: "< -> <=",
    operator: "boundary",
    category: "out-of-domain-input",
    distinguishingInput: "status = 600",
    reasoning:
      "HTTP status codes stop at 599. The mutant differs only for an input the domain cannot produce. Note that naming the distinguishing input makes this dismissible in one second, which matters more than suppressing it.",
    fix: "reachability-of-distinguishing-input",
  },
  {
    task: "T14-gb-postcode-no-space",
    file: "src/address.ts",
    line: 27,
    code: "return withoutSpaces.length > 3",
    mutation: "> -> >=",
    operator: "boundary",
    category: "out-of-domain-input",
    distinguishingInput: "a postcode of exactly 3 characters after removing spaces",
    reasoning:
      "No GB postcode is three characters. Reachable only through invalid input, and the difference is then discarded by the pattern check in validateAddress.",
    fix: "reachability-of-distinguishing-input",
  },

  // --- provably-equivalent --------------------------------------------------
  {
    task: "T17-money-allocate",
    file: "src/money.ts",
    line: 49,
    code: "const sign = amount.cents < 0 ? -1 : 1;",
    mutation: "< -> <=",
    operator: "boundary",
    category: "provably-equivalent",
    distinguishingInput: "amount.cents = 0",
    reasoning:
      "For zero cents the mutant picks sign -1 instead of +1, and every downstream part is computed as sign * 0. The observable output is identical, so no test could ever distinguish it.",
    fix: "differential-execution",
  },
  {
    task: "T17-money-allocate",
    file: "src/money.ts",
    line: 49,
    code: "const sign = amount.cents < 0 ? -1 : 1;",
    mutation: "0 -> 1",
    operator: "constant",
    category: "provably-equivalent",
    distinguishingInput: "amount.cents = 0",
    reasoning: "Same site, same zero-sign equivalence, and also redundant with the mutant above.",
    fix: "differential-execution",
  },

  // --- out-of-contract-observation -----------------------------------------
  {
    task: "T05-webhook-scheme-rejection",
    file: "src/webhooks.ts",
    line: 12,
    code: 'return header.split(",").some((part) => part.trim().split("=")[0] === scheme);',
    mutation: "=== -> !==",
    operator: "equality",
    category: "out-of-contract-observation",
    distinguishingInput: "any header containing a scheme component",
    reasoning:
      "hasSchemeComponent feeds only a log line. The mutant genuinely changes its return value, but nothing observable through the module's public contract changes.",
    fix: "observability-analysis",
  },

  // --- oblique -------------------------------------------------------------
  {
    task: "T01-order-wide-volume-discount",
    file: "src/pricing.ts",
    line: 46,
    code: "const totalQuantity = lines.reduce((total, line) => total + line.quantity, 0);",
    mutation: "0 -> 1",
    operator: "constant",
    category: "oblique",
    distinguishingInput: "an order whose total quantity is exactly at a discount tier boundary",
    reasoning:
      "Mutating a reduce() seed is a real behavioural change and does reveal that no test sits on a tier boundary. But 'the accumulator started at 1' is not how a developer thinks about that gap. The correct mutation target is the tier threshold in volumeDiscountRate.",
    fix: "better-mutation-targeting",
  },
  {
    task: "T10-tax-on-order-total",
    file: "src/pricing.ts",
    line: 51,
    code: "const groupNet = netByTaxRate.get(taxRate) ?? money(0);",
    mutation: "0 -> 1",
    operator: "constant",
    category: "oblique",
    distinguishingInput: "any order where the extra cent survives rounding",
    reasoning:
      "Seeding a group accumulator with one cent differs at many inputs, just not the ones tested. POC-01 called this equivalent; on re-examination it is not equivalent, it is simply a poor way to express 'the rounding of group totals is under-tested'.",
    fix: "better-mutation-targeting",
  },
];

export const TAXONOMY_SUMMARY = (() => {
  const byCategory: Record<string, number> = {};
  const byFix: Record<string, number> = {};
  for (const e of TAXONOMY) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byFix[e.fix] = (byFix[e.fix] ?? 0) + 1;
  }
  return { total: TAXONOMY.length, byCategory, byFix };
})();
