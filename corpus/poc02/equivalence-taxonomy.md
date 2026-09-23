# POC-02 equivalence and noise taxonomy

## POC-01 survivors revisited

The original POC-01 report counted 5 of 19 survivors (26%) as equivalent. The manual re-review in E12 corrected three of those labels. The stricter taxonomy is:

| Category | Count / 19 | Share | Treatment |
|---|---:|---:|---|
| Untested input class | 8 | 42% | Keep; this is the intended signal. |
| Redundant alternatives for one input gap | 4 | 21% | Deduplicate by distinguishing input. |
| Out-of-domain input | 2 | 11% | Surface the input so a reviewer can reject invalid cases. |
| Strictly equivalent | 2 | 11% | Requires call-path/domain proof or differential execution. |
| Oblique but behaviorally different | 2 | 11% | Improve mutation targeting and description. |
| Out-of-contract observation | 1 | 5% | Check whether the changed behavior affects the user contract. |

The strict equivalent rate is 2/19 (10.5%), not the initial 5/19 (26%). T10's money(0) to money(1) mutation is oblique, not equivalent. T07's three alternatives described one missing fractional input class.

## POC-02 strategy and result

The verifier moved from mutation-site grouping to distinguishing-input grouping. It generated 250 alternatives on the 22 POC-01 task diffs, reduced them to 73 distinct alternatives (71% fewer), and executed 69. The 12 survivors were manually classified as 5 true positives, 3 useful review findings, 1 strict equivalent, 1 out-of-contract, and 2 out-of-domain.

Strict-equivalent rate among these survivors was 1/12 (8.3%). This is a small change from POC-01's corrected 10.5% and does not establish reliable equivalence suppression. Grouping solved the measured redundancy problem; it did not prove reachability or eliminate equivalent behavior.

The T17 ratios-length survivor shows a separate distinction-input problem. The generator displayed length = 0 for an equality-literal change. Tests already asserted a RangeError for an empty list. The real missing valid behavior was a one-element ratio list, which the mutation also changes. A single reported value did not express both sides of the changed predicate.

## External observations

| Sample | Result | Taxonomy |
|---|---|---|
| gpt-6-sol external tasks X05/X06 | 5 alternatives executed; 4 caught, 1 survived | The survivor at ms = 0 is strictly equivalent because public call paths cannot reach it. |
| ms historical commit 3ba274e0 | Exact year boundary survived | True positive, manually confirmed. |
| bytes history | 31 alternatives executed on 8 usable commits; none survived | No finding to classify. |
| validator held-out commits | No alternatives generated on 3 commits | Generator coverage miss; no survivor precision can be calculated. |

The feedback-loop agent correctly explained the ms = 0 equivalence. The production verifier still reports that alternative as unverified. This taxonomy therefore helps review but does not yet automate suppression.

## Suppression strategy assessment

- **Worked:** grouping by distinguishing input substantially reduced duplicate reports on the authored corpus.
- **Partly worked:** excluding oblique locations and loop scaffolding prevented known poor-quality findings from the tuned qs, bytes, and camelcase examples.
- **Not solved:** the verifier has no general reachability or strict-equivalence proof. High confidence describes a mutation shape; it does not predict usefulness.
- **The 22-task replay did not include a gold-standard audit of every filtered or deduplicated alternative.** It cannot quantify whether targeting discarded useful mutants, on this corpus or beyond it.
