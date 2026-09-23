# POC-02 manual finding classifications

This file classifies every unverified result in the POC-02 authored-diff replay and the external replay evidence. “True positive” means the tests fail to pin a meaningful behavior required by the stated task. “Useful review” means the mutation raises a plausible concern whose importance depends on product contract or surrounding call patterns.

## Authored POC-01 task diffs

The raw run is in raw/verification/poc02-main.txt and raw/verification/poc02-main.json. There were 12 unverified alternatives across 9 of 22 tasks.

| Task | Mutation / reported input | Classification | Manual rationale |
|---|---|---|---|
| T05 webhook scheme rejection | == to !=; any input that decides the logging helper branch | Out of contract | The helper affects logging; changing it does not change request acceptance or signature behavior. |
| T07 banker’s rounding | + to - at lower + 1 | Useful review | Tests cover exact halves but not fractions strictly above 0.5. The output may be wrong for ordinary non-half values; the finding deserves a reviewer’s look. |
| T09 reservation quantity | 0 to 1; quantity = 1 | True positive | One is the smallest valid quantity, but no test reserves exactly one. The implementation could reject all single-item reservations. |
| T14 GB postcode | > to >=; stripped length = 3 | Out of domain | Three-character strings are not valid GB postcodes; the later format validation rejects them. |
| T15 webhook replay window | > to >=; timestamp exactly at tolerance | True positive | The security boundary is not tested at equality. An inclusive/exclusive change alters replay acceptance at the stated tolerance. |
| T17 money allocation | < to <=; amount cents = 0 | Strictly equivalent | The sign changes at zero, but the only downstream sign multiplication is by zero, so the observable amount is unchanged. |
| T17 money allocation | 0 to 1; tool reports ratios.length = 0 | True positive, with a misleading input label | The real missing case is a one-element ratio list. The empty-list test expects a RangeError, and the mutated branch falls through to a later zero-total RangeError, so that assertion still passes. With one ratio, the mutant throws when allocation should succeed. The generator presents the wrong side of an equality-to-literal mutation and misses the actionable input. |
| T18 atomic stock reservation | > to >=; requested quantity equals available stock | True positive | The exact-availability case should succeed, but is not covered. |
| T18 atomic stock reservation | - to + in availability bookkeeping | Useful review | A duplicate-SKU request can expose incorrect running-availability updates; the current tests do not use duplicate SKUs. |
| T20 pagination | < to <=; raw page size = 1 | True positive | One is the smallest valid page size and is absent from the task tests. |
| T22 retry status | < to <=; status = 600 | Out of domain | HTTP status 600 is outside the valid status range. |
| T22 retry status | >= 500 to >= 499; status = 499 | Useful review | Retrying 499 may be undesirable, but the task did not define how this status should be handled. |

Classification totals: 5 true positives, 3 useful review findings, 1 strict equivalent, 1 out-of-contract, and 2 out-of-domain. Eight of twelve were useful to a reviewer. They appeared across seven tasks.

## External history and second-model tasks

| Evidence | Finding | Classification | Manual rationale |
|---|---|---|---|
| ms history, commit 3ba274e0 (“add support for months”) | msAbs >= y to msAbs > y; exact one-year input | True positive | Existing tests used a year plus one millisecond. At exactly one year, the mutation routes to the month formatter and changes “1 year” to the month branch’s output. |
| X05, gpt-6-sol long-format truncation | 2 alternatives executed | No survivor | The full suite caught both alternatives. |
| X06, gpt-6-sol negative rounding | ms < 0 to ms <= 0; ms = 0 | Strictly equivalent | The private helper is only called after a positive unit-size threshold check. Zero cannot reach the condition through public callers. The feedback agent confirmed this and made no change. |
| validator history, three held-out commits | No alternatives generated | No manual finding | The operator set did not cover the changed lines. No tests were run by the verifier for these commits, so this is a generator-coverage limitation, not a clean-suite result. |

The two valid gpt-6-sol task runs had 0 useful survivors across 2 tasks. The X06 equivalent was one survivor among five executed alternatives across both tasks. The feedback replay repeats X06 and is not an independent sample.
