# TestSlop POC-00 — results

**Question.** Can a developer tool find meaningful, review-worthy problems in
AI-assisted test changes that linters, coverage reports and a green test run do
not make obvious?

**Answer.** Yes, for a specific and narrower class of problem than the original
brief imagined. **GO**, with a reduced v0.1 scope defined in section H.

The signal is real and it is genuinely unavailable to existing tools, but it comes
almost entirely from **two-revision comparison of assertion strength** and from
**targeted mutation of changed lines**. The rules that only inspect a single
snapshot were the ones that produced false positives, and one of them has been
removed from the default set on the evidence.

---

## A. What was built

A TypeScript CLI, `testslop`, that compares two revisions of a repository and
reports changes that weakened the test oracle.

```
testslop scan [--base <ref>] [--head <ref>] [--staged] [--mutate] [--json]
              [--rule <id>] [--skip-rule <id>] [--min-confidence <n>]
              [--fail-on high|medium|low|never] [--compact] [--quiet]
testslop rules
```

Pipeline: git change collection → language adapters → test/production linking →
rule engine → cross-rule dedupe → optional mutation verifier → reporters. Details
in [ARCHITECTURE.md](ARCHITECTURE.md).

**Languages.** TypeScript/JavaScript with Jest or Vitest is the primary target.
Python/pytest is supported through a second adapter whose purpose was to test
whether the normalised model is genuinely language-neutral. It is: adding pytest
required a parser pair and **zero rule changes**, and corpus case
`a13-pytest-assertion-weakened` — the pytest translation of the flagship
TypeScript case — is detected by the same rule with the same message.

**Scale.** 5,033 lines of implementation (`src/`), 13 rules of which 12 are on by
default and 10 are diff-aware, 96 analyzer tests, a 34-case corpus materialised as
real two-commit git repositories, and five measurement harnesses
(`corpus:build`, `evaluate`, `real-world`, `lint:compare`, `metrics`).

### Why TypeScript

Decided after evaluating both ecosystems rather than by default. The TS compiler
API parses TS, TSX, JS and JSX in single-file mode with no program and no type
checker, which is exactly what is needed to parse a revision that no longer exists
on disk. Python was the better *experimentation* environment but the worse
*distribution* environment for a tool whose main audience edits TypeScript. The
adapter boundary means that judgement is reversible.

---

## B. Rules explored

Thirteen rules were built. Twelve are on by default; one is demoted to opt-in.
Ten of the thirteen are diff-aware, meaning they cannot be expressed as a property
of a single snapshot of the code. Every "false positive found" note below refers to
a specific real commit, and every one has a regression test naming it.

### Survives into v0.1 — core

#### `assertion-weakened` — high confidence, the flagship

An assertion now accepts more behaviour than before. Implemented by pairing
assertions across revisions by normalised subject expression and comparing
strength classes.

```diff
- expect(response.status).toBe(401)          EXACT
+ expect(response.status).toBeDefined()      EXISTENCE
```

*Real find:* immer `1d930797` "minor cleanup" inverted
`expect(c.w).toBe(base.w)` to `.not.toBe(base.w)`. A one-word commit message over
a semantic inversion of an identity assertion.

*False positives found and fixed:* four distinct classes, all from real history —
negated occurrence assertions (`not.toHaveBeenCalled` pins a count of zero),
reference-identity negation (`not.toBe(obj)` is the canonical copy assertion),
error-message snapshots ranked above explicit messages, conditional-of-strings
arguments. See the strength lattice table in ARCHITECTURE.md.

*Verdict:* **keep.** This is the rule that justifies the product.

#### `expected-chasing-implementation` — the most product-defining rule

A test expectation moved in the same changeset as the implementation constant it
pins, and the new expectation is arithmetically derivable from the new code.

The derivability check is what makes this more than a co-change warning. Given
`0.12 → 0.10` in production and `120 → 100` in the test, TestSlop verifies that
`120 × (0.10/0.12) = 100` and reports *why* it is suspicious. When no derivation
holds, the finding drops from high to medium and says the coupling is normal for a
legitimate requirements change.

*Zero false positives* in 424 real commits — but see the caveat: it also produced
zero true positives there, because it requires a numeric expectation and a numeric
constant to move together, which is rarer in library code than in application
code. It fires reliably on the corpus (a02, d05).

*Verdict:* **keep.** Invisible to mutation testing by construction, since the
suite is green before and after. No linter can express it.

#### `test-disabled` — highest precision in the default set

A running test became `skip` / `todo` / `failing`, reported alongside the
production change that accompanied it.

*Real finds:* 6 of the 8 high-severity findings across 424 real commits.
zustand `9062ca63`, a commit titled `chore: remove __DEV__ with ts-jest`, silently
skipped two tests. immer `d0f3a714` "Reimplement ES5 to work with descriptors"
skipped four.

*False positive found and fixed:* ky uses ava's `test.failing` as a permanent
known-failure marker. Because the rule only skipped pre-existing `skip`/`todo`, it
re-reported the same two tests on **every** commit that touched their file: 12
findings in 100 commits, zero of them transitions. Fixed by requiring a transition
out of the active state.

*Overlap:* `jest/no-disabled-tests` reports the same skipped tests — but reports
them forever, in every file, with no distinction between a test skipped three
years ago and one skipped in this commit next to the code it was guarding.

*Verdict:* **keep.**

#### `changed-logic-survived` — the only `evidence`-class finding

Targeted mutation of changed production lines. See section E.

*Verdict:* **keep, opt-in via `--mutate`.**

### Survives into v0.1 — supporting

| Rule | Evidence | Verdict |
| --- | --- | --- |
| `assertion-removed` | 7 real findings, 6 at low severity. Required recognising throwing queries (`getByText`, `waitFor`) as assertions — zustand `257ac06a` replaced two `expect` calls with `await waitForElement(() => getByText('count: 0'))`, a better test that the naive rule called "no longer asserts anything". | keep, mostly low severity |
| `self-derived-oracle` | Detects tautologies (`expect(f(x)).toBe(f(x))`) at 0.95 confidence, and expectations that re-implement a production return expression via token-skeleton similarity. Zero false positives in real history; also zero true positives there. Fires on corpus a05. | keep, watch |
| `test-only-production-path` | Production code branching on `NODE_ENV === 'test'`, `JEST_WORKER_ID`, `BYPASS_AUTH`. Zero findings in real history, which is the expected result for mature libraries. The failure mode it catches is severe and invisible to every test-focused tool, because it lives in production source. | keep |
| `snapshot-replaced-assertion` | 2 real high-severity findings in immer. Explicit expectations traded for a generated snapshot. | keep |
| `exception-broadened` | Fires on corpus a09. Partially overlaps `jest/require-to-throw-message`, but that rule reports the end state; this reports the loss of specificity. | keep, low severity |
| `mock-scope-expanded` | A test began mocking the module it imports as its subject. Zero real findings, fires on corpus a12. Narrow but unambiguous. | keep |
| `coverage-ignore-added` | 2 real findings. Aggregated per file after immer added four pragmas to one module in one commit. Directly inflates the coverage number, which is the metric being trusted. | keep, low/medium |
| `test-removed` | 13 real findings, all at low or medium. Split out of `test-disabled` and gated on three conditions (move/rename detection, per-file aggregation, net verification loss) after the combined rule produced 71 findings on zustand where 2 were signal. | keep, low severity |
| `weak-new-test` | 4 real findings. Required distinguishing a bare existence check on a whole result (an honest smoke test) from one on a named field (oracle degradation), and negated `toThrow` (a contract) from bare `toThrow` (a vague oracle). | keep, medium |

### Demoted to opt-in

#### `mock-only-test` — does not earn a default slot

A test asserts only that collaborators were called, never what was communicated.

*Measured precision:* 4 findings on zustand, 9 on axios. On manual review,
essentially all were legitimate. The recurring reason is structural: for
middleware, adapters and lifecycle code, *"was this called, how many times"* **is**
the observable behaviour. zustand's `devtools` middleware has no return value;
its contract is the messages it sends. axios's `Http2Sessions` tests assert that
`session.close` was not called, which is exactly the behaviour under test.

Three successive refinements each removed a slice of the noise — treating
argument-pinning interactions as outcome assertions, suppressing files whose
established style is interaction testing, and correctly classifying negated
occurrence assertions — without reaching a precision worth defaulting to.

*Verdict:* **implemented, documented, `experimental: true`, excluded from the
default set.** Available via `--rule mock-only-test`. This is recorded as a
negative result rather than quietly shipped.

### Explored and not built

- **Order / time / random dependence, sleep-based waiting, duplicate tests.**
  Well covered by existing linters and by `eslint-plugin-jest` specifically. No
  change-context advantage.
- **Missing-behaviour detection** (changed branch has no assertion, boundary case
  absent). Attempted as a static rule and abandoned: every formulation either
  demanded type information TestSlop deliberately does not compute, or produced
  guesses. **Targeted mutation answers the same question with executed evidence**,
  which is strictly better. This is the clearest case in the POC of mutation
  earning its place.
- **Test-only production API changes** (visibility weakened for tests). Needs
  cross-repository call-graph analysis to distinguish from normal refactoring.
  Out of scope.

---

## C. Existing-tool comparison

Run with **every** `eslint-plugin-jest` rule enabled, and with the fixtures
rewritten to jest globals so that rules which resolve `it`/`expect` through their
import source are not handicapped. Reproduce with `npm run lint:compare`.

|  | TestSlop | eslint-plugin-jest |
| --- | --- | --- |
| Findings on 19 deliberately degraded diffs | 28 | 130 |
| Findings on 13 clean diffs designed to mimic them | **1** | **81** |
| Clean diffs it fired on | 1 / 13 | **13 / 13** |
| Distinct rules fired | 12 | 15 |
| Semantic overlaps across the whole corpus | — | **3** |

The decisive row is the third. ESLint fires on every single clean case. Its
findings do not distinguish a diff that improved the suite from one that gutted
it, because they are not about that: they are `padding-around-expect-groups`,
`prefer-lowercase-title`, `require-hook`, `prefer-strict-equal`. Useful, and
orthogonal.

Three ESLint rules have genuine semantic overlap — `no-disabled-tests`,
`require-to-throw-message`, `prefer-called-with` — and all three report a *state*
rather than a *transition*. `no-disabled-tests` cannot tell you the test was
skipped in this commit. `require-to-throw-message` fires on corpus case b07 where
the test was *improved*.

Ten TestSlop rules have no counterpart at all.

**An honest correction to the brief's framing.** `jest/expect-expect` never fired
anywhere in the corpus, including on all fourteen deliberately degraded cases.
That is the whole thesis in one data point: the degraded tests all *have*
assertions. They are simply assertions that cannot fail.

### Versus Stryker / mutmut

Stryker answers "how good is this test suite?" over a whole project, in minutes
to hours, and reports a score. TestSlop asks "do the tests that changed alongside
this line notice when this line is wrong?", in tens of seconds, and reports a
sentence. Scoping to changed lines is the entire difference, and it is what makes
survivors interpretable.

Stryker also cannot see `expected-chasing-implementation` or `test-disabled` at
all — the suite is green before and after in the first case, and there is no
mutant to run in the second.

### Versus coverage

Every Category A case in this corpus maintains or increases line coverage.
`coverage-ignore-added` raises it directly.

### Versus a general AI code reviewer

An LLM would plausibly find several of these. It would also be nondeterministic,
unbenchmarkable, expensive per diff, and unable to tell you *why* it was
confident. TestSlop's `expected-chasing-implementation` states the arithmetic that
makes it suspicious. That is auditable; a model's opinion is not.

---

## D. Agent experiments

Six tasks (`corpus/cases/category-d.ts`), each a seeded repository plus a task
description, worked as an agent would: get the task done, get the suite green, add
tests that look like they cover the work.

| Case | Task | What the agent produced | TestSlop |
| --- | --- | --- | --- |
| d01 | Fix an off-by-one in pagination, add tests | Correct fix, five tests pinning both boundaries and the remainder page | **nothing** (correct) |
| d02 | Add email/password/username validation | Five validation branches, one test asserting `toThrow()` and one asserting `toBeDefined()` | `weak-new-test`; **mutation: 2/2 survived** |
| d03 | "The cache test is failing on CI. Make the suite green." | Rewrote the expectation to match the buggy output and softened two matchers. Production untouched — the eviction-order bug is still there. | `assertion-weakened` ×2 |
| d04 | Add exponential backoff retry, add tests | Correct implementation; tests assert call counts only. Nothing verifies the backoff curve or the defaults. | `mock-only-test` (opt-in); **mutation: 6/14 survived** |
| d05 | "dateRange excludes the end date. Make it inclusive." | Correct fix, then rewrote every expectation from the new output — including turning `it('returns an empty range for identical bounds')` into an assertion that the range has **one** element | `expected-chasing-implementation` |
| d06 | Refactor a 40-line tokeniser, keep tests passing | Clean extraction, tests untouched | **nothing** (correct) |

d03 and d05 are the two most valuable results. **d03 is the Self-Repair Trap**
documented in [Improving Test Oracle Generation via Dual-Context Awareness](https://arxiv.org/html/2608.05917),
where iterative repair drives models toward assertions that are easier to satisfy
but worse at detecting faults. **d05 is a test whose name now contradicts its own
assertion** — the kind of thing that survives review because the diff looks like
"updated expected values".

d01 and d06 are controls. Both produce zero findings, and both had mutants killed.

### The methodological problem, stated plainly

**These diffs were written by the author of the tool.** The author knows what
TestSlop detects, and that knowledge cannot be fully unlearned while writing
samples. Category D therefore demonstrates that the patterns are *expressible in
plausible agent output* and that TestSlop's behaviour on such output is
reproducible. It does **not** establish the rate at which an independent agent
produces these patterns on unseen repositories.

Mitigations applied: two of the six cases are deliberate controls where the agent
did competent work, and both come out clean. Expectations were written by reading
the finished diff as a reviewer. But the honest summary is that **the base rate is
unmeasured**, and measuring it is the first thing v0.1 must do. It is listed as
such in section H.

---

## E. Mutation results

`--mutate` mutates only production lines the diff touched, runs only the changed
tests linked to that file, and reports survivors grouped per enclosing function.

| Case | Mutants | Killed | Survived | Predicted | Wall time |
| --- | --- | --- | --- | --- | --- |
| a06 boundary not pinned | 2 | 1 | **1** | survivor | 11.3 s |
| d02 validation untested | 2 | 0 | **2** | survivor | 10.0 s |
| d04 backoff untested | 14 | 8 | **6** | survivor | 50.9 s |
| **d01 agent wrote good tests** | 1 | **1** | **0** | none | 7.6 s |
| **b05 boundaries pinned both sides** | 11 | **11** | **0** | none | 41.7 s |

**5 of 5 predictions correct, including both negative controls.** That last point
is the one that matters: a mutation harness that finds survivors everywhere is not
evidence of anything. Killing 11 of 11 in the well-tested case and 1 of 1 in the
agent's clean case is what makes a survivor meaningful.

The a06 result is the single most compelling finding in the POC. The task was
"allow withdrawals that exactly equal the available balance". The implementation
uses `amount >= balance + overdraftLimit`, which **rejects** the equality case —
the opposite of the requirement. The accompanying test never exercises the
boundary. Flipping `>=` to `>`, which would make the code *correct*, leaves the
suite green. The tests cannot distinguish the implementation from its fix.

d04's survivors are `delayFor`'s exponential curve (`*` → `/`, base `2` → `3`,
offset `1` → `2`) and the module's `DEFAULTS` — because every test passes explicit
config, nothing verifies the defaults ship correctly.

**Cost.** 24 s average per case, 7.6–51 s range, on small repositories. Dominated
by test-runner startup, not by mutant count. Acceptable for a pre-commit or
pre-review step; too slow for save-on-type. Correctly gated behind `--mutate`.

**Caveat.** ["How effective are traditional test criteria at detecting bugs in LLM generated code?"](https://arxiv.org/abs/2609.09315)
reports that mutation-based criteria struggle with the *hard* LLM-induced faults
even when they catch trivial ones. TestSlop's mutation is narrower than that study's
target and the corpus results are strong, but it should not be read as a general
guarantee.

---

## F. Metrics

Reproduce with `npm run evaluate`, `scripts/real-world.ts`, `scripts/metrics.ts`.
Raw output in `work/METRICS.txt`.

### Detection on the synthetic corpus

Measures rule *behaviour*, not precision — the corpus is author-written.

| | |
| --- | --- |
| Cases | 34 (A 14, B 14, D 6) |
| Expected rule instances detected | **20 / 20** |
| False positives | **0** |
| Grey-zone (defensible but noisy) | 2 |
| Clean cases producing zero findings | 16 / 17 |
| Median scan time | 2 ms |

### Precision on real history

The part that is not author-controlled, and therefore the only real measure.
424 single-parent commits from five mature repositories, restricted to commits
touching both test and production code.

| Repo | Commits | With findings | Rate | Findings | High | High/100 | Median ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| axios | 100 | 3 | 3% | 3 | 0 | 0.0 | 86 |
| immer | 100 | 14 | 14% | 30 | 6 | 6.0 | 76 |
| ky | 100 | 0 | 0% | 0 | 0 | 0.0 | 159 |
| redux | 24 | 1 | 4% | 1 | 0 | 0.0 | 35 |
| zustand | 100 | 4 | 4% | 6 | 2 | 2.0 | 45 |
| **Total** | **424** | **22** | **5%** | **40** | **8** | **1.9** | |

- **0.09 findings per commit**, **0.019 high-severity per commit**
- A developer sees any finding on **1 in 20** reviewed commits, and a
  high-severity one on **1 in 53**
- All 8 high-severity findings are `test-disabled` (6) and
  `snapshot-replaced-assertion` (2). On review, all 8 are genuine.

immer at 14% is the outlier, and the reason is real rather than a defect: the
sampled window covers several major deprecations (ES5 support removal, promise
producers removal, MapSet plugin rework) which legitimately delete tests. 23 of its
30 findings are low severity.

**ky's 0% is not a clean bill of health.** ky uses ava. TestSlop parsed all 256 of
its test cases and analysed **zero assertions**, because `t.is()` / `t.like()` are
not modelled. This was initially mistaken for a good result; the tool now reports
the gap explicitly rather than implying a clean scan. See Known limitations.

### Runtime

| | |
| --- | --- |
| Static scan, corpus median | 2 ms |
| Static scan, real repositories median | 35–159 ms |
| Static scan, immer `__tests__/base.js` (300 cases, 831 assertions) | ~76 ms |
| Mutation-assisted, per case | 7.6–51 s (avg 24 s) |

Fast enough for a pre-commit hook without `--mutate`.

### Unique value

| | |
| --- | --- |
| TestSlop findings on degraded corpus cases | 28 |
| Of those, reported by eslint-plugin-jest at the same location | 0 semantically |
| Semantic overlaps corpus-wide | 3 (all state-not-transition) |
| Rules with no eslint-plugin-jest counterpart | 10 of 13 |

### What the measurement process cost

Nine distinct false-positive classes were found by running against real history,
and each one produced a rule change plus a regression test naming the commit that
exposed it. The effect on noise, measured on the same 120 zustand commits:

| | Findings | Commits with findings |
| --- | --- | --- |
| Before real-history measurement | 114 | 24% |
| After | **6** | **3%** |

A **19× reduction**. None of it would have been visible from the author-written
corpus, which reported 100% recall and 0 false positives throughout. That is the
most transferable methodological lesson in this POC: **a self-authored corpus
measures whether the code does what you meant, and nothing about whether what you
meant was right.**

---

## G. Product evaluation

### Does TestSlop solve a meaningful problem?

Yes, and the problem is independently documented. The literature names this exact
failure mode: the [Self-Repair Trap](https://arxiv.org/html/2608.05917), where
iterative repair pushes models toward assertions that are easier to satisfy but
worse at detecting faults; [LLM test generators that validate bugs rather than
catch them](https://arxiv.org/html/2412.14137v1); and [fault detection rates near
zero because oracles fail to capture faulty behaviour](https://arxiv.org/abs/2609.09315).
*(Sources rephrased for compliance with licensing restrictions.)*

The real-history data supports it from the other direction. Even in mature,
carefully reviewed repositories, TestSlop found commits that silently skipped
tests (`chore: remove __DEV__ with ts-jest`, 2 tests; "Reimplement ES5", 4 tests)
and one that inverted an identity assertion under the message "minor cleanup".
Those are human commits. Agent-generated diffs are produced faster and reviewed
less carefully.

### Is diff-aware test analysis genuinely different from linting?

Yes, and this is the strongest conclusion in the POC. ESLint fired on 13/13 clean
cases with 81 findings; TestSlop fired on 1/13 with 1. `jest/expect-expect` — the
rule most directly aimed at this problem — fired on **none** of the fourteen
deliberately degraded cases, because all of them have assertions. The defect is in
what the assertions admit, and that is only legible against a previous revision.

### Is targeted mutation worth keeping?

Yes, with two conditions: opt-in, and always with a baseline check.

It is the only mechanism that produced `evidence`-class findings, it is the only
thing that caught a06 and d02 and d04, and it replaced an entire category
(missing-behaviour detection) that could not be done statically with acceptable
precision. The negative controls are what make it trustworthy.

It is not sufficient alone. `expected-chasing-implementation` and `test-disabled`
are invisible to it.

### Which patterns are strongest?

1. `assertion-weakened` — the flagship. Precise, explainable, unavailable elsewhere.
2. `changed-logic-survived` — the only executed evidence.
3. `test-disabled` — 6 of 8 real high-severity findings; near-perfect precision after the ava fix.
4. `expected-chasing-implementation` — most product-defining; the derivability proof is the differentiator.
5. `snapshot-replaced-assertion` — 2 real high-severity findings.
6. `assertion-removed` — solid once throwing queries are understood.
7. `test-only-production-path` — rare, severe, structurally invisible to every other tool.
8. `self-derived-oracle` — the tautology half is near-certain.
9. `weak-new-test` — useful after the smoke-test distinction.
10. `coverage-ignore-added` — cheap, directly attacks the metric being trusted.

### Should this project continue?

**Yes.** Success criteria from the brief:

| # | Criterion | |
| --- | --- | --- |
| 1 | Analyses an actual git diff | yes, 424 real commits |
| 2 | Understands a real framework | Jest + Vitest, plus pytest |
| 3 | Source-located findings | file, line, test name |
| 4 | Findings depending on before/after | 10 of 13 rules |
| 5 | Meaningful weakness in a realistic diff | d03, d05, plus 8 real-history high-severity |
| 6 | Linters do not already report it | 3 semantic overlaps of 28; all state-not-transition |
| 7 | False positives manageable | 5% of commits, 1.9 high per 100 |
| 8 | Understandable without reading the source | before/after evidence on every finding |
| 9 | Reasonable local runtime | 2–159 ms static |
| 10 | Architecture supports more languages | demonstrated, not asserted: pytest, zero rule changes |
| 11 | At least one finding backed by behavioural evidence | 5 mutation cases, 2 negative controls |
| 12 | Demo understandable in 20 seconds | the `a01` and `a02` outputs in the README |

Twelve of twelve, with the honest caveat on #5 that the agent diffs are
author-simulated.

**What would have made this a NO-GO,** and did not:

- Needing an LLM for the core signal. It does not; the analyser is fully deterministic.
- Findings reducing to obvious lint output. 3 semantic overlaps out of 28.
- Mutation alone providing the same value. It cannot see 2 of the top 4 rules.
- Unmanageable false positives. 5% of commits after nine measured fixes.
- No compelling before/after result. a02's derivation proof and a06's surviving boundary mutant both are.

---

## Known limitations

**Assertion libraries.** Only Jest/Vitest `expect` and pytest `assert` are
modelled. ava, chai's `expect(x).to.equal(y)`, `should`, `node:assert` and tape are
not. On such files TestSlop parses test structure — enough for `test-disabled` and
`test-removed` — and reports that oracle analysis did not run. ky demonstrates the
severity: 256 cases parsed, zero assertions analysed.

**Test pairing is by title.** Renaming a test breaks pairing across revisions, so
a rename-plus-weaken escapes `assertion-weakened`. Parameterised suites that reuse
one title (immer's `base functionality - ${name}`) collide in the name map. A body
fingerprint already exists for `test-removed` and should be used for pairing too.

**Module resolution.** Relative imports and filename convention only; tsconfig
path aliases and monorepo workspace aliases are unresolved, so cross-file rules
silently lose linkage in aliased codebases.

**`expected-chasing-implementation` needs numeric literals.** Expectations
expressed as objects, strings or computed values are not correlated. This is why
it found nothing in 424 library commits despite firing reliably on the corpus.

**Mutation requires a green, reasonably fast, file-filterable suite.** Detection
covers vitest and jest. Baseline failure disables the feature with an explanation
rather than guessing.

**`--mutate` writes to the working tree.** Originals are restored in a `finally`
and synchronously on `SIGINT`/`SIGTERM`, and mutants are skipped when the file has
drifted from the analysed revision, but a hard kill can still leave a mutated
file. Committing before running is the safe habit.

**No cross-file test relocation for pairing.** A test moved between files is
correctly not reported as removed, but its assertions are not compared either.

**The agent-diff base rate is unmeasured.** Section D.

---

## H. Recommended v0.1

**GO**, with scope cut to what the evidence supports.

### Ship

Six rules, on by default:

```
assertion-weakened
expected-chasing-implementation
test-disabled
assertion-removed
snapshot-replaced-assertion
test-only-production-path
```

Plus `--mutate` producing `changed-logic-survived`, and
`coverage-ignore-added`, `exception-broadened`, `self-derived-oracle`,
`weak-new-test`, `test-removed` at low severity, on by default but excluded from
`--fail-on high`.

`mock-only-test` stays opt-in and documented as a negative result.

TypeScript/JavaScript with Jest and Vitest only. pytest stays in the tree as proof
of the boundary, and is not advertised as supported until it has its own
real-history evaluation.

### Do first, before adding any rule

1. **Measure the agent base rate.** Run real coding agents on 20–30 seeded tasks
   across repositories the tool author did not write, and score TestSlop against
   independent human review. This is the one number POC-00 does not have, and
   every scope decision after this depends on it.
2. **Fix test pairing** to use the body fingerprint, not the title. Currently a
   rename defeats the flagship rule.
3. **Extend `expected-chasing-implementation`** to string and structural
   expectations. It is the most differentiated rule and it currently only sees
   numbers.
4. **Add a second assertion adapter** — chai or ava — chosen by measuring which
   appears more in agent-touched repositories. Silent non-analysis is the worst
   failure mode this tool has.

### Do not build yet

Everything in the brief's "do not build" list still holds. Specifically resist the
GitHub App and the dashboard: the value proposition is a fast local check in the
loop where the agent is working, and nothing measured here suggests a hosted
product adds to it.

### The one-line positioning the evidence supports

> Coverage went up. Confidence didn't.

Not "better test linting" — the comparison shows the two do not overlap. Not
"mutation testing" — mutation cannot see half the top rules. The product is
**oracle regression detection on a diff**, and the demo that sells it is
`expected-chasing-implementation` printing the arithmetic that proves a test
expectation was copied out of the implementation.
