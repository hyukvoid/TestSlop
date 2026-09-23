# TestSlop POC-02 Report

**Decision: NO-GO — do not publish a public v0.1.**

POC-02 validated a useful mechanism on the authored POC-01 task diffs. It did not establish reliable value on external coding-agent work. One useful boundary finding came from exploratory human history in ms, while the valid second-model agent tasks produced no useful survivor. One of their five executed alternatives was strictly equivalent. Existing mutation tooling already covers much of the changed-line workflow.

The recommendation is to stop work toward a public release of this product shape. Keep the repository and raw evidence as a research archive.

## A. Starting hypothesis

POC-01 invalidated the original oracle-degradation thesis on its 22 evaluable tasks: static rules found nothing, and the agent wrote 301 assertions with none at or below EXISTENCE. Targeted mutation then found missing input classes on 6/22 tasks. The product hypothesis changed to: tests added with a code change may pass while failing to constrain a meaningful nearby behavior.

POC-01 initially reported 5/19 surviving mutants as equivalent (26%). E12 re-reviewed all survivors and classified only 2/19 as strictly equivalent (10.5%); several earlier labels were redundant, oblique, or outside the input domain. POC-02 tested behavior-keyed mutation and human-readable distinguishing inputs.

The requested starting POC-01 commit was 894e31ed. The checkout was already at d5b635b, whose parent is the requested commit and which contains initial POC-02 implementation. I inspected and preserved the dirty working tree before continuing.

## B. Equivalent-mutant taxonomy

The corrected POC-01 taxonomy is: 8 untested input classes, 4 redundant alternatives, 2 out-of-domain inputs, 2 strict equivalents, 2 oblique changes, and 1 out-of-contract observation.

The POC-02 authored replay produced 12 survivors: 5 true positives, 3 useful review findings, 1 strict equivalent, 1 out-of-contract result, and 2 out-of-domain results. Full per-finding classifications are in corpus/poc02/manual-findings.md; the consolidated taxonomy is in corpus/poc02/equivalence-taxonomy.md.

## C. Suppression strategy

POC-02 grouped alternatives by their distinguishing input. On the same 22 diffs, it generated 250 alternatives, deduplicated to 73 (71% fewer), and executed 69. It caught 57, left 12 unverified, and had no linking-only misses. Mean wall time was 8.2 seconds per task.

Grouping materially reduced duplicate reports. It did not prove reachability or remove strict equivalents. One T17 finding was also labeled with the wrong side of an equality mutation: the report said ratios.length = 0, while the actionable missing case was a one-element ratio list. The empty-list assertion still passed because a later guard also raises RangeError. The report needs better input explanations.

The experiment did not independently audit every filtered or deduplicated alternative against a gold standard. It therefore cannot quantify whether targeting ever discarded a useful alternative.

## D. Agent experiments

POC-01's agent was Codex with gpt-5.6-luna. The initial POC-02 Codex external arm recorded six empty diffs after the CLI hit its usage limit. Claude Code 2.1.88 was installed and authenticated, but four explicit-model attempts failed before task work, and four alias retries failed with monthly quota exhaustion.

A preregistered four-task run with Codex gpt-6-sol completed on public bytes and ms snapshots. The two bytes requests described behavior already present: pebibyte support and negative unit parsing. X01 changed tests/docs only; X02 refactored the parser and added tests for behavior the baseline already supported. These are invalid task premises and are excluded from the valid-task denominator.

The two ms requests were valid behavior changes. X05 passed 168 tests and X06 passed 182. Both added positive/negative boundary coverage. This is a different Codex model, not cross-provider replication. TestSlop found no useful survivor in these two tasks after manual review.

## E. External repository experiments

The later matching bytes history records had 8 usable baselines among 18 candidates and no survivors across 31 executed alternatives. The bytes history had shaped mutation filters, so it is development data.

The later matching ms history records had 2 usable baselines among 14 candidates. One high-confidence alternative survived: on commit 3ba274e0, changing the year threshold from inclusive to exclusive survives at exactly one year. Existing tests used year plus one millisecond. Manual review confirms this changes output from the year branch to the month branch. This is one useful external historical finding, but the small, inconsistent history sample is exploratory, not held-out validation.

The larger qs and camelcase history runs produced survivors, but those repositories directly informed loop, type-test, and other operator filters. They are excluded from independent success metrics. The held-out validator sample selected three real commits; the generator produced no alternatives on their changed lines. This is a generator-coverage miss, not a clean-suite result. Its pinned HEAD build and test command passed 323 tests.

Older bytes/ms summaries conflict with later structured records. E19 and E22 use the later matching JSON/text pairs and preserve the conflicting files in the raw archive.

## F. True-positive rate

On the authored POC-01 corpus, 8/12 surviving findings were useful (5 clear true positives and 3 useful review findings), spread across 7/22 tasks. Five tasks had a clear true positive.

On the two valid gpt-6-sol tasks, 0/2 had a useful TestSlop finding after manual review. The ms history run adds one useful survivor among its two usable commits, from one exploratory repository. These populations are too different and too small to pool into a single product precision number.

## G. Equivalent-mutant rate

After manual recategorization, strict equivalence was 2/19 (10.5%) in POC-01 and 1/12 (8.3%) in the POC-02 authored replay. The POC-02 external sample had one survivor among five executed alternatives; it was strictly equivalent. The feedback replay repeated that same result and is not an independent observation.

The lower authored-corpus rate is encouraging but not decisive. A high-confidence label did not separate useful and equivalent findings.

## H. False negatives

The POC-01 manual review found missing cases at quantity 1, exact replay tolerance, non-half rounding fractions, singleton/zero ratio handling, duplicate SKU updates, and page size 1. POC-02 surfaced most of those on the replayed diffs.

The exact HMAC digest remains a static-analysis blind spot: a test can pin a value obtained from the implementation and still be maximally exact. The T17 ratios-length case shows that a mutation can identify a real gap while naming an already-tested input. The validator history sample demonstrates another limitation: changed lines can have no generated alternatives, preventing any test-strength conclusion.

There is no labeled external corpus large enough to estimate false-negative rate.

## I. Runtime and safety

The authored replay averaged 8.2 seconds per task. The successful full-suite replays took 9.97 seconds for X05 and 16.01 seconds for X06. Full-suite baseline runs took 4.71 and 8.02 seconds respectively. These are practical for a post-agent check, though full-suite fallback is slower than linked-test execution.

A filtered Jest baseline failed because its global coverage threshold was calculated on only the changed files. The verifier now retries the full suite and uses it for each mutant when that fallback is green. A second fix resolves nested node_modules junctions before linking dependencies into the scratch sandbox. Regression tests cover both cases.

Mutation writes remain in a scratch copy; the analyzed source tree is not modified. Tests run with the developer's privileges, so this protects source files from TestSlop mutations rather than acting as a security boundary.

## J. Feedback-loop experiment

The gpt-6-sol feedback run inspected the X06 ms = 0 survivor in a separate clone preserving the original diff. It followed the public call path and correctly explained that round(ms, n) is reached only after a positive unit threshold, so zero cannot reach the changed condition. It made no changes. The full Node and Edge suites each passed 182 tests; the verifier repeated the same 1 equivalent survivor.

This shows an agent can reject a false positive when given context. The product still reports the equivalent alternative, so the feedback loop depends on a reviewer or a separate reasoning step.

## K. Existing-tool comparison

StrykerJS overlaps with the proposed workflow. Its incremental mode tracks code and test changes, its custom mutate configuration accepts file/line ranges, and its per-test coverage analysis runs tests associated with mutants. See the official [incremental-mode documentation](https://stryker-mutator.io/docs/stryker-js/incremental/) and [configuration documentation](https://stryker-mutator.io/docs/stryker-js/configuration/).

TestSlop's remaining distinction is grouping alternatives by a named input and explaining the unconstrained behavior in domain language. POC-02 did not establish enough external precision or agent-specific value to justify that extra product layer.

## L. Product identity

The tested concept is a changed-behaviour verifier for coding-agent diffs: mutate changed production behavior, run relevant tests, and report surviving alternatives with an input description. Static test linting is secondary and did not support the original thesis.

## M. Final decision

**NO-GO — insufficient evidence for public v0.1.**

The authored corpus has a useful signal, and the ms history result confirms that changed-behavior verification can find a real external boundary gap. The valid second-model tasks produced zero useful findings, the only external agent survivor was equivalent, external history availability was low, and a held-out repository produced no alternatives. StrykerJS already covers much of the changed-code mutation workflow. A small difference in presentation is not enough evidence of a distinct product.

## N. Public v0.1 scope

None. Do not publish or release a public v0.1. Preserve the implementation, analyzer regressions, benchmark definitions, manual classifications, raw records, and evidence log as a research archive.

## Validation performed

- npm run typecheck — passed.
- npm test -- --reporter=dot — 221 tests passed across 6 files.
- npm run build — passed after report edits.
- Pinned validator.js HEAD build and test command — 323 tests passed.
- External ms X05/X06 full suites — 168 and 182 tests passed; replay baselines green after the E25 fixes.
- Feedback clone Node and Edge suites — 182 tests each passed.
