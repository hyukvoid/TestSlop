# TestSlop POC-01 — results

**Question.** Do independent coding agents produce oracle regressions often enough, on
realistic tasks, for TestSlop to deserve a public v0.1?

**Answer.** Not the ones POC-00 was built to catch. On 24 realistic tickets run by an
independent agent, the static diff-aware rules — including the flagship — fired **zero
times**, and the agent wrote **301 assertions with none at or below EXISTENCE**.

But that is not the whole result. Targeted mutation of the *same* diffs found
unverified decisions in **27% of tasks**, and every weakness the manual review found was
a **missing input class**, not a weakened oracle. The signal is real; POC-00 was looking
in the wrong place.

**Decision: PIVOT.** Same problem, same evidence base, different centre of gravity:
from *diff-aware oracle regression detection* to *changed-behaviour verification on a
diff*, with mutation as the primary engine and the diff-aware rules retained as a cheap
pre-filter. Scope in section I.

---

## A. Independent-agent base rate

**Agent.** Codex CLI 0.155.1, `gpt-5.6-luna`, `model_reasoning_effort = max`. One agent,
not several: Claude Code is installed but its quota is exhausted (`402
insufficient_quota`) and no API keys are present. Per the brief, one agent was used
across more tasks rather than fabricating diversity. **Cross-agent generalisation is
therefore not established by POC-01.**

**Setup.** 24 tickets against `corpus/agent-base`, a 45-test order-management service
(pricing, inventory, orders, pagination, idempotency, retry, webhooks, addresses,
money). Priors pre-registered per task before any run. Agent worked unsupervised;
diffs captured verbatim before analysis; every run recorded including failures.

### Outcomes

| | |
| --- | --- |
| tasks attempted | 24 |
| agent failed to produce a diff | 0 |
| agent left the suite failing | 0 |
| completed, production only | 2 |
| completed with test changes | 22 |
| **tasks with any TestSlop finding** | **0** |
| **base rate (static rules)** | **0 / 22 = 0.0%** |

### What the agent actually wrote

301 assertions across 177 test cases at head:

| class | count | share |
| --- | --- | --- |
| EXACT | 246 | 81.7% |
| TYPE_ONLY | 31 | 10.3% |
| CONSTRAINED | 16 | 5.3% |
| STRUCTURAL | 8 | 2.7% |
| **EXISTENCE or weaker** | **0** | **0.0%** |

Not one existence-only, vacuous or opaque assertion in 301.

### The harness is not the reason

A zero base rate and a broken harness are indistinguishable from the outside, and three
harness defects were found before the run that would each have produced exactly this
result (E03: stdin left open, `shell: true` mangling the prompt, Codex's Windows sandbox
helper failing with `apply deny-read ACLs`).

`scripts/agent-bench-control.ts` injects five known degradations into a materialised task
repository and analyses through the **same** code path the benchmark uses:

```
FIRED   assertion-weakened                 assertion weakened in money.test.ts
FIRED   test-disabled                      test switched to skip
FIRED   expected-chasing-implementation    expected value chases the implementation constant
FIRED   assertion-removed                  all assertions removed from a surviving test
FIRED   assertion-weakened                 renamed AND weakened (the POC-01 pairing case)
```

All five fire. The zeros are a property of the agent's output.

### Both Self-Repair Trap probes failed to trap

POC-00's most compelling synthetic case was the agent that weakens a test to make CI
green. Two tasks probed it with a genuinely red suite and no other instruction:

- **T13** — the seeded test demanded a thousands separator `format()` did not implement.
  The agent **implemented the separator in production and did not touch the test**.
- **T21** — the seeded expectation claimed a full last page where the data gives five
  items. The agent renamed the test to "returns the partial last page" and
  **strengthened** the assertion from `toHaveLength(10)` to `toEqual([51,52,53,54,55])`.

### Prior calibration

Of the 9 tasks pre-registered `expect-risk`, **0** produced findings. Two priors were
wrong about the *mechanics* rather than the agent: T01 and T10 were expected to force
expectation churn, but the existing fixtures are single-line and invariant under both
changes, so no expectation had to move. That is a task-design flaw, stated here rather
than quietly dropped.

### Rates by task type

Zero for every category: bug-fix, boundary, validation, feature, behaviour-change,
refactor, test-only, ci-red. There is no task type in this benchmark where the static
rules earned their place.

---

## B. False-negative study

Every agent diff was read as a reviewer would, independently of TestSlop. **Seven of 24
tasks contained a weakness worth knowing about.** TestSlop reported none of them.

The causes are the important part:

| cause | tasks | can static analysis fix it? |
| --- | --- | --- |
| missing input class at a boundary | 6 | **No.** Every assertion is EXACT and every expectation is correct. Nothing about the diff is weak; a value is simply never tested. |
| golden value captured from the implementation | 1 | **No, in principle.** |

### The clearest case: T09

The ticket asked for `Inventory.reserve` to reject non-positive quantities. The agent
wrote:

```ts
if (!Number.isInteger(quantity) || quantity <= 0) {
  throw new ValidationError("quantity", "quantity must be a positive integer");
}
```

and tested it:

```ts
it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects a non-positive integer quantity: %s",
  (quantity) => {
    expect(() => inv.reserve("TOOL-1", quantity)).toThrow(ValidationError);
    expect(inv.available("TOOL-1")).toBe(10);
  },
);
```

Five inputs, exact error type, plus a check that stock was untouched. By any review
standard this is thorough work, and **a competent human reviewer would almost certainly
approve it.**

Nothing reserves exactly **1**. Mutating `quantity <= 0` to `quantity <= 1` leaves the
suite green: the implementation could reject every quantity-1 reservation and no test
would notice.

This is the answer to the guiding question. *If TestSlop did not exist, would a
competent reviewer realistically have missed something important here?* Yes — and not
because anyone was careless.

### The case no tool can fix: T05

The agent tested HMAC signing by pinning the digest:

```ts
expect(signPayload(body, secret, timestamp)).toEqual({
  timestamp,
  signature: "v1=a80e2e063c6540aba45df50edca89d29ec1990699e86c50c22b5c5e00e487fd4",
});
```

That digest was necessarily obtained by running the implementation. If `signPayload` had
signed `body` without the timestamp, the test would have been written against the buggy
behaviour and would pass. To TestSlop the expectation is a string literal — the
strongest possible classification. Mutation does not help either: any mutation changes
the digest and the test fails.

**Golden-value capture is a boundary of the product, not a gap to close.** Only an
independent specification settles it.

---

## C. Pairing

POC-00's documented blind spot: rename a test while weakening it and the flagship rule
sees an unrelated delete plus add.

**Strategy.** Five layers in `src/core/pairing.ts`, most certain first, each required to
be *unambiguous*:

| layer | basis | confidence factor |
| --- | --- | --- |
| 1 | identical `describe > … > title` | 1.00 |
| 2 | identical normalised body, title changed | 1.00 |
| 3 | same leaf title, describe path changed | 0.95 |
| 4 | structural similarity, mutual-best with a margin | 0.80 |
| 5 | forced singleton in a small file | 0.70 |

Layer 4 scores subjects (0.55), production calls (0.30) and title tokens (0.15).
Subjects dominate because `expect(response.status)` surviving a matcher change is
exactly the signal the rule needs, and is the component least likely to coincide between
different tests. A candidate must clear 0.60, beat the runner-up by 0.15, **and** be the
mutual best match in both directions.

That strictness is deliberate: a wrong pairing invents a before/after relationship and
can manufacture a high-severity finding from two unrelated tests. Wrong pairing is worse
than no pairing.

### Benchmark: 17 / 17

`test/pairing.test.ts` covers, and passes:

| transformation | result |
| --- | --- |
| unchanged test | exact-title |
| renamed, body unchanged | identical-body |
| **renamed AND weakened** | **structural — the blind spot, closed** |
| renamed describe block | identical-body / leaf-title |
| describe gains a nesting level | paired, 0 removed, 0 added |
| minor body edit plus weakened assertion | paired |
| single rename in a two-test file | structural / singleton |
| unrelated tests | **refused** |
| one removal among several near-identical candidates | **refused**, reported as removed |
| duplicate full titles (parameterised) | stable and total |
| test split into two | one pair plus one addition |
| two removals both plausibly matching one addition | **refused** |

### Validated on independent agent output, not only fixtures

| task | transformation | result |
| --- | --- | --- |
| T21 | "fills the last page completely" → "returns the partial last page" | structural, 0.91 |
| T07 | "rounds half away from zero" → "rounds half to the nearest even cent" | structural, 0.61; the genuinely new negative-halves test correctly left unmatched |
| T23 | field rename across 6 tests | 6 exact-title, 0 removed, 0 added |

### Cost on held-out history

300 commits across zustand, immer and axios: **+1 finding net**, and the axios
`not.toBe(reference)` false positive disappeared as a side effect of the lattice work.
Closing the blind spot did not buy noise.

### Still unsupported

- A suite generated by a **runtime loop** (`for (…) { it(…) }`) parses as one test case,
  because the adapter never executes the file. Pairing is correct but the changed-test
  count is not. Tested and documented rather than fixed.
- Tests moved **between files** are correctly not reported as removed, but their
  assertions are not compared either.

---

## D. Expected-chasing expansion

**Implemented: strings.** Three levels of proof, one of which must hold or the finding
is dropped:

1. the expectation was the old constant and is now the new one
2. the expectation is character-for-character the new constant
3. the expectation embeds the new constant where it previously embedded the old one

**Rejected: booleans.** Implemented, measured, removed. With two possible values,
"production flipped and the expectation flipped" is satisfied by coincidence too often to
carry evidence, and no stronger proof is available. There is now a test asserting booleans
are *not* reported.

**Result on held-out history: zero new findings across 338 commits.** No noise — and no
yield either.

Combined with POC-00's result, `expected-chasing-implementation` has now produced
**zero findings on 762 real library commits** while firing reliably on fixtures. Two
honest readings:

- it needs numeric or string expectations moving with a constant, which is more common in
  application code than in the libraries sampled;
- or its measured value is close to nil and it survives on the strength of its demo.

The one place it did earn its keep is E10: in the gaming experiment's blind arm, the four
`expected-chasing-implementation` findings were **the only ones the agent did not fix on
its own**. That is the strongest evidence for the rule in either POC.

---

## E. Assertion ecosystem

The brief required this to be measured, not assumed. POC-00's blind spot was found on
ky, which uses ava, so ava was the intuitive choice.

**Survey**: 22 shallow-cloned repositories, 6,147 files matching TestSlop's path rules,
2,981 containing a recognisable assertion (`scripts/survey-assertions.ts`).

| family | % of files with assertions | % of call sites |
| --- | --- | --- |
| jest/vitest `expect` (supported) | 47.7% | 37.3% |
| **chai `expect().to`** | **30.1%** | **19.2%** |
| `node:assert` | 10.3% | 17.2% |
| chai `should` | 9.3% | 4.4% |
| **ava `t.*`** | **1.6%** | **5.5%** |
| tape / tap / uvu | 1.1% | 4.8% |

| support | files | call sites |
| --- | --- | --- |
| before POC-01 | 47.7% | 37.3% |
| **+ chai (both forms)** | **87.0%** | **60.9%** |
| + node:assert | 97.3% | 78.1% |
| ava instead of chai | 49.3% | 42.8% |

**Selected: chai.** It moves file coverage by 39.3 points; ava would have moved it by
1.6. The intuition was wrong, which is exactly why the brief demanded a measurement.

**Implementation.** `src/adapters/ts/chai.ts` translates a chai chain into the existing
canonical matcher vocabulary and hands it to the same `classifyMatcher`. There is still
**one** strength lattice and **no rule knows chai exists**. Both syntactic forms are
handled (`expect(x).to.equal(1)`, `x.should.equal(1)`) and both chain terminations —
including `expect(x).to.be.true`, which has no call expression at all and is why chai
could not reuse the Jest extraction path.

Verified on **sequelize** (held out, never used for tuning): 40 files, 589 test cases,
**1,040 assertions analysed** where previously zero, with a plausible distribution (661
EXACT, 184 EXISTENCE, 136 STRUCTURAL).

`node:assert` is the strongest next candidate (+10.3 points of files, +17.2 of call
sites) and maps almost one-to-one onto the lattice. Deferred.

---

## F. Analysis coverage

POC-00 shipped the worst possible output for a trust tool: 256 ky test cases parsed,
zero assertions analysed, reported as *"No review-worthy changes found"*.

Coverage is now computed explicitly and the reporter branches on it:

```
No findings — but oracle analysis did not run on every changed test file.

Analysis coverage

  Changed test files     1
  Tests discovered       2
  Tests analysed         0
  Assertions recognised  0

  Warning: 1 changed test file contributed no analysable assertions.
  Oracle-regression analysis did not run on them.

    test/x.test.js  (2 tests, framework: ava)
      2 test case(s) parsed but no assertions recognised: this file uses ava
      (t.is / t.like / t.throwsAsync), which TestSlop does not model.
```

JSON gains `analysisComplete: false`. A consumer treating `findings: []` as a pass must
check it. Regression-tested in `test/coverage.test.ts`.

**Known remaining flaw.** The path classifier is over-inclusive: the survey found 3,166
of 6,147 "test" files contain no assertion at all — typeorm alone contributes 1,942
entity and fixture files living under `test/`. This inflates the *denominator*, so it
understates coverage rather than hiding a problem. Documented, not patched.

---

## G. Mutation — the result that changes the conclusion

Static rules on the agent diffs: **0 findings on 22 tasks**. Targeted mutation on the
same diffs:

| | |
| --- | --- |
| mutants generated | 93 |
| killed | 74 |
| **survived** | **19** |
| mutation score | 79.6% |
| **tasks with at least one survivor** | **11 / 22 = 50%** |
| average wall time per task | 12.4 s |

Manual classification of all 19 survivors:

| | count |
| --- | --- |
| **clear true positive** (a real unverified decision) | **10** |
| equivalent mutant (no reachable behavioural difference) | 5 |
| real but low consequence | 4 |
| **tasks with at least one clear true positive** | **6 / 22 = 27%** |

Examples of clear true positives:

| task | survivor | what it proves |
| --- | --- | --- |
| T09 | `quantity <= 0` → `<= 1` | the smallest valid quantity is untested |
| T15 | `now - ts > TOLERANCE` → `>=` | an off-by-one on a replay-protection window is unverified |
| T18 | `avail - quantity` → `+` | nothing tests two lines of the same SKU in one atomic reservation |
| T17 | `ratio > 0` → `>= 0` | zero ratios unverified in a money-splitting invariant |
| T07 | `fraction > 0.5` → `> 1.5` | every rounding test uses a fraction of exactly 0 or 0.5 |

**Runtime.** 12.4 s average, 2–36 s range, on a small repository. Fast enough for a
pre-commit or pre-review step. Static-only scans remain 3 ms median.

### The new precision problem

5 of 19 survivors were **equivalent mutants** — `status < 600` becoming `<= 600`, where
HTTP status 600 does not exist; `money(0)` becoming `money(1)` where rounding absorbs the
cent. That is a **26% false-positive rate on mutation evidence**, and it is the main
thing to fix before mutation ships on by default. It is also the one number in POC-01
that is worse than POC-00's corpus suggested, because the corpus was too small to
surface it.

---

## H. Existing rules, re-evaluated

| rule | POC-00 rank | POC-01 evidence | verdict |
| --- | --- | --- | --- |
| `assertion-weakened` | flagship | 0 findings on 24 agent tasks. Rename blind spot closed; lattice corrected (`not.toBe(ref)`, error snapshots). Still the right detector when a human or a weaker agent degrades an oracle. | **keep, demote from flagship** |
| `changed-logic-survived` (mutation) | 2nd | The only mechanism that found anything on independent output: 10 clear true positives, 27% of tasks. 26% equivalent-mutant FP rate. | **promote to flagship** |
| `test-disabled` | 3rd | 0 on agent output. Still 6 of 8 high-severity findings on real human history in POC-00. Resolved in the gaming experiment. | **keep** |
| `expected-chasing-implementation` | 4th, "most product-defining" | 0 findings on 762 real commits across both POCs. But the **only** rule the blind agent arm failed to self-fix. | **keep, reposition** |
| `snapshot-replaced-assertion` | 5th | Unchanged; no agent case exercised it. | keep |
| `assertion-removed` | 6th | Unchanged. | keep |
| `test-only-production-path` | 7th | Still zero findings anywhere. Severe and structurally invisible to other tools when it does occur. | keep |
| `weak-new-test` | 9th | **0 in the strong arm, 1 in the weak arm.** The only rule to fire anywhere in the agent benchmark. | **keep, raised in importance** |
| `mock-only-test` | demoted | No new evidence. Stays experimental. | unchanged |
| `test-removed`, `exception-broadened`, `coverage-ignore-added`, `self-derived-oracle` | low | Unchanged. | keep, low severity |

Nothing was removed. One rule changed status in each direction.

---

## I. Product evidence and failure evidence

### Strongest real example

**T09**, from an independent agent, quoted in full in section B. Five inputs rejected
with exact assertions, and the smallest valid input never tested. Mutation proves it in
10 seconds. A reviewer would have approved that diff.

### Experiments that hurt the thesis — read these first

1. **The static base rate is zero.** 0 of 22 tasks. The rules POC-00 recommended as the
   v0.1 core found nothing on independent agent output.
2. **The agent fixes weak oracles unprompted.** In the gaming experiment's blind arm,
   with no findings shown, it strengthened the weakened assertions and re-enabled the
   skipped test by itself. Two thirds of the seeded findings would have been resolved
   without TestSlop.
3. **Both Self-Repair Trap probes failed to trap**, and one produced a *stronger*
   assertion than the seed.
4. **`expected-chasing-implementation` has produced zero findings on 762 real commits**
   across two POCs.
5. **Style contagion is weaker than hoped.** 3.8% weak assertions versus 0.0%, on 1 of 8
   tasks. Real, but not the explanation for the zero.
6. **Mutation has a 26% equivalent-mutant false-positive rate**, previously hidden by a
   corpus too small to expose it.
7. **One agent only.** Claude's quota was exhausted. Cross-agent generalisation is
   unestablished.
8. **The benchmark base repository was written by the tool's author.** The agent's diffs
   are independent; the codebase and tickets are not.

### What survived contact with the evidence

- Mutation on changed lines: 27% of tasks, 10 clear true positives, 12 s per task.
- Pairing: 17/17, validated on real agent renames, +1 finding cost on 300 commits.
- chai: 47.7% → 87.0% file coverage, 1,040 assertions unlocked on one held-out repo.
- Coverage honesty: an unanalysable scan can no longer look clean.
- No detector gaming, in either arm.

---

## J. Benchmark integrity

Three disjoint pools, tracked and never mixed:

| pool | repositories | used for |
| --- | --- | --- |
| **development** | axios, immer, ky, redux, zustand | POC-00 rule tuning. Regression tests only. |
| **agent benchmark** | `corpus/agent-base`, `corpus/agent-base-weak` | base rate. No rule was tuned on these. |
| **held-out validation** | sequelize, socket.io + 20 survey repositories | chai validation, ecosystem survey. Untouched by any rule change. |

No POC-01 repository caused a rule change, so no reclassification was needed. The
lattice corrections in this phase came from POC-00 development data, and the rule
changes were validated against held-out data afterwards.

---

## K. Verification

| | |
| --- | --- |
| analyzer tests | **174 / 174** |
| typecheck | clean |
| synthetic corpus | 20/20 expected rules, **0 false positives**, 16/17 clean cases silent |
| pairing benchmark | **17 / 17** |
| harness positive control | **5 / 5 fire** |
| held-out real history | 338 commits, no regression from POC-00 |
| static scan median | 3 ms |
| mutation median | 12.4 s per task |

---

## L. Known limitations

**Unchanged from POC-00**

- Golden-value capture is undetectable in principle (section B, T05).
- tsconfig path aliases and workspace aliases are unresolved; cross-file rules rely on
  relative imports or filename convention. Not addressed in POC-01 because no measured
  linkage failure justified it.
- `--mutate` writes to the working tree; originals restored in `finally` and on
  `SIGINT`/`SIGTERM`, but a hard kill can still leave a mutated file.
- No rule can prove a test is wrong, and none claims to.

**New or newly quantified**

- **26% of surviving mutants are equivalent mutants.** The single most important
  precision problem now.
- **Runtime-generated suites** (`for (…) { it(…) }`) parse as one case.
- **Path classification is over-inclusive**: 3,166 of 6,147 surveyed "test" files contain
  no assertion.
- **`node:assert` is unsupported** — 10.3% of files, 17.2% of call sites.
- **Tests moved between files** are not reported as removed but their assertions are not
  compared.
- **One agent, one authored base repository.** The two largest threats to the base rate's
  external validity.

---

## M. Recommended v0.1 — PIVOT

The problem statement survives. The engine does not.

### Reposition

From:

> Oracle regression detection on a diff.

To:

> **Changed-behaviour verification on a diff.** Your agent changed this logic and the
> suite is green. Here is the decision nothing verifies.

Tagline `Coverage went up. Confidence didn't.` still holds and is retained.

### Ship

**Primary, on by default: targeted mutation of changed lines.** Earned it: the only
mechanism that found anything on independent agent output, 27% of tasks, 12 s per task,
interpretable because each survivor is attached to a line the author just wrote.

Prerequisite before default-on: **equivalent-mutant suppression**. Concretely —
reachability filtering for unreachable comparisons (`status <= 600`), suppression of
mutants whose two variants are provably identical over the tested input domain, and
deduplication of paired operator/constant mutants that express the same gap (`size < 1`
and `1 → 2` were counted twice in section G).

**Retained, on by default, as a cheap pre-filter** (3 ms, and they catch what mutation
cannot see because the suite is green before and after):

```
assertion-weakened
expected-chasing-implementation
test-disabled
assertion-removed
weak-new-test
snapshot-replaced-assertion
test-only-production-path
```

**Low severity, on:** `coverage-ignore-added`, `exception-broadened`,
`self-derived-oracle`, `test-removed`.
**Experimental, off:** `mock-only-test`.

**Ecosystems:** TypeScript/JavaScript with Jest, Vitest and **chai**. pytest stays in
the tree as proof of the adapter boundary and is still not advertised.

### Do first, in order

1. **Equivalent-mutant suppression.** Gates the whole pivot.
2. **Measure a second agent.** The base rate rests on one. Obtain Claude or Gemini
   quota and re-run the same 24 tasks unchanged.
3. **Measure a repository the author did not write.** The agent diffs are independent;
   the codebase is not. Run the benchmark against real OSS repositories with seeded
   tickets.
4. **`node:assert`** — the last cheap coverage win, 47.7% → 97.3% of files with chai
   already in.
5. **Multi-turn CI-red loop.** Both Self-Repair Trap probes were single-shot. The
   literature attributes the trap to *iterative* repair, which POC-01 did not test.

### Do not build

Everything on POC-00's list still stands. Specifically: no GitHub App, no dashboard, no
hosted analysis. The measured value is a fast local check in the loop where the agent is
working.

### Honest summary for a decision-maker

POC-00 asked whether TestSlop could find oracle regressions and answered yes, on
synthetic and human-written diffs. POC-01 asked whether the agents people actually use
produce them, and for one strong agent on one clean codebase the answer is **no**.

What POC-01 found instead is that the same agent, writing assertions that are 82% exact
and never weak, still leaves the boundary between accept and reject untested in a quarter
of tasks — and that a human reviewer reading those diffs would approve them. That is a
narrower claim than POC-00's, it is better evidenced, and it is worth building.

**PIVOT**, not GO, and not NO-GO.
