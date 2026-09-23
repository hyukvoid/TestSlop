# POC-01 evidence log

Chronological record of hypotheses, experiments, results and decisions. Written
as the work happens, to prevent retrospective reasoning about why a decision was
"obviously" right.

Starting commit: `03ba0017ec371e63e9f18d8faa5ef0396a65a09c` (POC-00 final).

---

## E01 — Which independent agents are actually available

**Hypothesis.** More than one independent coding agent can be exercised, giving
cross-agent evidence rather than single-agent evidence.

**Experiment.** Probe the machine for installed agent CLIs and run a trivial
headless prompt against each.

**Result.**

| Agent | Installed | Headless probe |
| --- | --- | --- |
| Claude Code 2.1.88 | yes | **fails**: `API Error: 402 insufficient_quota — You have exceeded your credit quota for this month` |
| Codex CLI 0.155.1 | yes | **works**, responded in 17 s |
| gemini, aider, opencode, cursor-agent, copilot, goose, crush | no | — |

No API keys present in the environment, so Claude cannot be revived by supplying
credentials.

**Decision.** Follow the brief's instruction for this case: use the one working
agent across **more tasks** rather than fabricating diversity. All independent
diffs in POC-01 come from Codex CLI. Cross-agent generalisation is therefore
**not** established by POC-01 and is recorded as an open question, not as a
finding.

Invocation standardised as:

```
codex exec -C <repo> -s workspace-write --skip-git-repo-check "<task prompt>"
```

`--sandbox workspace-write` lets the agent edit files and run the test suite while
confining writes to the task repository.

---

## E02 — Benchmark data separation

**Problem.** POC-00 tuned rules against axios, immer, ky, redux and zustand. Nine
false-positive fixes were derived from those repositories, which makes them
**development data**. Quoting precision on them again would be self-validation.

**Decision.** Three disjoint pools, tracked explicitly and never mixed:

| Pool | Repositories | Used for |
| --- | --- | --- |
| **Development** | axios, immer, ky, redux, zustand | POC-00 rule tuning. Regression tests only from here on. |
| **Agent benchmark** | repositories introduced in POC-01, listed in `corpus/agent-tasks/` | Independent-agent base rate. Never used to tune a rule. |
| **Held-out validation** | repositories introduced in POC-01 and touched by no rule change | Final precision numbers. |

If a POC-01 repository exposes a false positive and a rule changes because of it,
that repository is reclassified as development data and stops counting as
validation. Reclassifications are recorded in this log.

---

## E03 — Getting Codex to actually do work headlessly

Three separate harness defects, each of which silently produced a *plausible but
false* benchmark result. Recorded because each one would have corrupted the base
rate in a different direction.

| Symptom | Cause | Would have been recorded as |
| --- | --- | --- |
| 900 s timeout, empty diff | `execFile` leaves stdin open; `codex exec` prints `Reading additional input from stdin...` and blocks, because piped stdin is appended to the prompt | `agent-failed` on every task |
| Exit in 0 s, empty diff | `shell: true` on Windows mangles the prompt argument (quotes, apostrophes) | `agent-failed` on every task |
| 361 s, agent tries hard, empty diff | Codex's Windows sandbox helper fails: `Failed to create unified exec process: helper_unknown_error: apply deny-read ACLs`. The agent could neither read nor patch files, and said so in its final message. | `agent-failed` on every task |

**Fixes.** stdin closed (`stdio: ["ignore", ...]`); shell used only for the `npx`
shim, never for `codex`; sandbox relaxed to `danger-full-access`.

**Note on the sandbox change.** `workspace-write` is the correct policy and was the
first choice. It is unusable on this host. Running the agent unsandboxed is a real
risk and is mitigated only by scoping each run to a throwaway repository under
`work/agentbench/<task>/`. During a probe run the agent did attempt an
`Invoke-WebRequest`, which the shell declined by default. This is an environmental
compromise, not a recommendation.

**Also disabled:** the machine's configured MCP servers (`shadcn`, `playwright`,
`node_repl`) via `-c mcp_servers={}`. They added startup latency and failed
repeatedly, consuming agent turns on infrastructure rather than the task.

**Lesson worth keeping.** Every one of these three defects produced a *confident,
well-formed, completely wrong* result. If the first run had been on 24 tasks
instead of 1, the report would have concluded "independent agents produce no
analysable diffs" and POC-01 would have recommended NO-GO on a harness bug.

---

## E04 — Which second assertion ecosystem (measured, not assumed)

**Hypothesis.** POC-00's blind spot was discovered on ky, which uses ava, so ava is
the obvious second ecosystem to support.

**Experiment.** Shallow-clone 22 popular JS/TS repositories and classify every
assertion call site in their test files by API family
(`scripts/survey-assertions.ts`). 6,147 files matched TestSlop's path rules; 2,981
contained a recognisable assertion.

**Result.**

| Family | % of files with assertions | % of call sites |
| --- | --- | --- |
| jest/vitest `expect` (supported) | 47.7% | 37.3% |
| **chai `expect().to`** | **30.1%** | **19.2%** |
| `node:assert` | 10.3% | 17.2% |
| chai `should` | 9.3% | 4.4% |
| **ava `t.*`** | **1.6%** | **5.5%** |
| tape, tap, uvu | 1.1% | 4.8% |

Cumulative coverage:

| Support | files | call sites |
| --- | --- | --- |
| today | 47.7% | 37.3% |
| + chai (both forms) | **87.0%** | **60.9%** |
| + node:assert | 97.3% | 78.1% |
| ava instead of chai | 49.3% | 42.8% |

**Decision.** Implement **chai**, covering both `expect(x).to.equal(y)` and
`x.should.equal(y)`. It moves file coverage by 39.3 points; ava would move it by
1.6. The POC-00 intuition was wrong, which is precisely why the brief required this
to be measured.

`node:assert` is recorded as the strongest *next* candidate (+10.3 points of files,
+17.2 of call sites) and is cheap, because `assert.strictEqual` maps onto the
lattice almost one-to-one. Deferred to keep POC-01 scope honest.

**Side finding, reported separately.** 3,166 of the 6,147 files TestSlop classified
as tests contain no assertion at all. They are overwhelmingly entity definitions,
fixtures and helpers living under a `test/` directory — typeorm alone contributes
1,942. TestSlop's path classifier is therefore **over-inclusive**, which inflates
the "tests discovered" count. This matters for the analysis-coverage report, where
an inflated denominator would understate coverage. Addressed in E06.

---

## E05 — Expected-chasing beyond numbers

**Hypothesis.** The derivability standard that makes the numeric detector credible can
be extended to other expectation types without turning the rule into "a test and its
code changed together".

**Experiment.** Implemented string support with three levels of *proof* (expectation
tracked the constant on both sides; expectation adopted the new constant exactly;
expectation embeds the new constant where it previously embedded the old one), and
required one of them to hold or the finding is dropped entirely. Measured on 338
held-out commits.

**Result.** Zero new findings on real history, zero false positives, and the intended
fixtures fire. Booleans were implemented and then removed: with two possible values,
"production flipped and the expectation flipped" is satisfied by coincidence far too
often to be evidence, and no proof stronger than coincidence is available.

**Decision.** Keep strings. Reject booleans, with a test asserting they are *not*
reported. Note honestly that the whole rule — numeric and string — produced **zero
findings across 338 real commits**, so its value rests on the demo and on application
code rather than on measured library-code yield.

---

## E06 — Analysis coverage must be explicit

**Problem.** POC-00 shipped a case where 256 ky test cases were parsed, zero
assertions were analysed, and the report said "No review-worthy changes found". The
POC-01 survey then found that 3,166 of 6,147 files TestSlop classifies as tests
contain no recognisable assertion at all.

**Decision.** Compute coverage explicitly (`src/core/coverage.ts`) and make the
reporter branch on it. An incomplete scan prints a warning headline instead of the
green line, and the JSON gains `analysisComplete: false`. Regression-tested against an
ava fixture.

**Not fixed.** The path classifier remains over-inclusive: a fixture or entity file
under `test/` is still counted as a discovered test. This inflates the denominator
rather than hiding a problem, so it is recorded as a limitation instead of being
patched under time pressure.

---

## E07 — The independent-agent base rate

**Hypothesis (POC-00's thesis).** Independent coding agents produce oracle regressions
— weakened assertions, retrofitted expectations, disabled tests — at a rate that
justifies a tool.

**Experiment.** 24 realistic tickets against a 45-test order-management service, run
unsupervised by Codex CLI (gpt-5.6-luna, max reasoning). Priors pre-registered per
task. Diffs captured verbatim. A positive control injected known-degraded edits through
the same analysis path to prove the harness can see findings at all.

**Result.**

| | |
| --- | --- |
| tasks attempted | 24 |
| agent failed | 0 |
| left the suite red | 0 |
| completed with test changes | 22 |
| **tasks with any TestSlop finding** | **0** |
| assertions the agent wrote | 301 |
| **assertions at or below EXISTENCE** | **0 (0.0%)** |
| EXACT | 246 (81.7%) |

Positive control: all five injected degradations fired, including rename-plus-weaken.
The zeros are a property of the agent's output, not of the harness.

Both Self-Repair Trap probes failed to trap. Given a red suite and no other
instruction, the agent implemented the missing feature (T13) and corrected a wrong
expectation while *strengthening* the assertion (T21).

**Decision.** This contradicts POC-00's central premise for this agent on this class of
task, and it is the finding POC-01 exists to report. Do not soften it. Continue to E08
and E09 before drawing a product conclusion.

---

## E08 — Style contagion

**Hypothesis.** E07's zero is partly a property of the *repository*, not the agent: the
base suite is exemplary, and agents imitate local convention.

**Experiment.** Second arm with identical production code and an existing suite
rewritten in a weak style (existence checks, bare `toThrow`). Eight of the same tasks,
same agent, same prompts. Only assertions the agent *added* are counted, isolated via
the pairing module against the base revision.

**Result.**

| arm | new tests | assertions | at/below EXISTENCE | findings |
| --- | --- | --- | --- | --- |
| strong existing tests | 40 | 104 | **0 (0.0%)** | 0 |
| weak existing tests | 40 | 104 | **4 (3.8%)** | 1 |

The one finding is `weak-new-test` on T17, where four distinct rejection reasons were
collapsed into bare `toThrow()`. The same task in the strong arm got exact assertions.

**A correction worth recording.** The first version of this measurement reported 28.8%
weak in the weak arm. That was wrong: it parsed the whole file at head and so counted
the *seeded* weak tests as the agent's work. Isolating the agent's additions dropped
the figure to 3.8%.

**Decision.** Style contagion is real and directionally supports the thesis, but it is
a small effect on a small sample (1 of 8 tasks). Report it as suggestive, not
established.

---

## E09 — Does mutation find what the static rules cannot?

**Hypothesis.** If the agent's assertions are strong, there is nothing left to find.

**Experiment.** Targeted mutation on the changed production lines of all 22 agent
diffs that touched production code, running only the related changed tests.

**Result.** 93 mutants, 74 killed, **19 survived** (79.6% mutation score).
**11 of 22 tasks had at least one surviving mutant**, against 0 of 22 for the static
rules.

Manual classification of the 19 survivors:

| | |
| --- | --- |
| clear true positives (a real unverified decision) | 10 |
| equivalent mutants (no reachable behavioural difference) | 5 |
| real but low consequence | 4 |
| **tasks with at least one clear true positive** | **6 / 22 = 27%** |

The clearest: T09. The agent rejected quantity `0, -1, 1.5, NaN, Infinity` with exact
assertions — thorough by any review standard — but nothing reserves exactly **1**.
Mutating `quantity <= 0` to `quantity <= 1` survives, so the implementation could
reject every quantity-1 reservation with the suite green.

**Decision.** This inverts POC-00's ranking. The static diff-aware rules, including the
flagship, produced nothing on independent agent output; mutation produced review-worthy
evidence on 27% of tasks. Every missed weakness identified in the manual review was a
**missing input class**, not a weakened oracle — a category the static rules cannot
address by construction. The product conclusion follows from this, not from E07 alone.

**New limitation exposed.** 5 of 19 survivors were equivalent mutants (`status < 600`
becoming `<= 600`, where status 600 does not exist). That is a 26% false-positive rate
on mutation evidence and the main precision problem to solve before shipping mutation
as a default.

---

## E10 — Gaming the detector

**Hypothesis.** Inside an agent loop, TestSlop findings get silenced rather than fixed.

**Experiment.** A repository seeded with a previous agent's degraded diff (two
assertions weakened, one test skipped, a tax rate and its expectations retrofitted),
producing six findings. Two arms: *informed*, given TestSlop's verbatim report; *blind*,
asked only to review the last commit's tests.

**Result.**

| arm | classification | findings before → after | behaviour |
| --- | --- | --- | --- |
| informed | restored-oracle | **6 → 0** | strengthened assertions, re-enabled the skipped test, and reverted the production constant |
| blind | restored-oracle | **6 → 4** | strengthened assertions and re-enabled the test, but left the expected-chasing coupling |

No deletion, no renaming-to-evade, no suppression directives, in either arm.

**Two conclusions, one comfortable and one not.**

Comfortable: the agent does not game the detector, and the informed arm resolved
everything.

Uncomfortable: the blind arm fixed the weakened assertions *without being told*. The
agent found those on its own. TestSlop's measured marginal contribution in this
experiment is the four `expected-chasing-implementation` findings — the coupling
between a changed constant and its retrofitted expectations — which the blind arm
missed entirely.

**Decision.** This is the strongest single piece of evidence for what the product
should be: the value is concentrated in the findings an agent reviewing its own work
does *not* reach, not in the ones it would fix anyway.

---

# POC-02

Starting commit: `894e31ed2960f0aa89070fedd2dda1ca5292ef54` (POC-01 final).

## E11 — Second agent, again unavailable

**Goal B** asked for a genuinely independent second agent.

| candidate | result |
| --- | --- |
| Claude Code 2.1.88 | still `API Error: 402 insufficient_quota`, unchanged from POC-01 |
| `codex -m gpt-5.1-codex` | `The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT account` |
| `codex -m gpt-5.1-codex-max` | same rejection |
| `codex -m gpt-5-codex`, `o4-mini` | same rejection |
| gemini, aider, opencode, cursor-agent, copilot, crush, goose | not installed |

No API keys are present in the environment, so no candidate can be revived by
supplying credentials. `gpt-5.6-luna` is the only model reachable.

**Decision.** Follow the brief's fallback: document the constraint and **increase
repository diversity instead**. POC-02's external-repository work therefore carries the
weight that a second agent would have carried, and *agent generalisation remains
unestablished across two consecutive phases*. This is stated in the report as a
standing limitation, not a footnote.

Changing reasoning effort was considered as a within-model arm and rejected: it is a
different operating point of the same model, not an independent agent, and presenting it
as diversity would be exactly the fabrication the brief warns against.

---

## E12 — Equivalent-mutant taxonomy, built from the actual survivors

**Hypothesis.** POC-01's "~26% equivalent mutants" is one problem with one fix.

**Experiment.** Re-examined all 19 surviving mutants against the real source, one at a
time, and recorded a category plus the required fix for each
(`corpus/equivalence-taxonomy.ts`).

**Result.** It is six problems with four different fixes, and only two of nineteen are
equivalent in the strict sense.

| category | n | share | fix |
| --- | --- | --- | --- |
| untested-input-class — the product working | 8 | 42% | keep |
| **redundant** — one gap, several edits | **4** | **21%** | group by distinguishing input |
| out-of-domain-input | 2 | 11% | reachability of the distinguishing input |
| **provably-equivalent** | **2** | **11%** | differential execution |
| oblique — real but unrecognisable to a developer | 2 | 11% | better mutation targeting |
| out-of-contract-observation | 1 | 5% | observability analysis |

Two corrections to POC-01's own classification, found during this pass:

- T10's `money(0)` → `money(1)` was called equivalent. It is not: it differs at many
  inputs, just not the tested ones. It is **oblique** — a real gap expressed in a way no
  developer would recognise.
- T07's three survivors were counted as three findings. They are **one** missing input
  class reached by three different edits.

**Decision.** The strict equivalence rate is **11%, not 26%**, and the largest fixable
category is redundancy, which is a grouping problem. Attack in order of measured size:
grouping first, targeting second, reachability third. Differential execution is deferred
unless the 11% proves to matter after the first two.

---

## E13 — Distinguishing inputs as the organising idea

**Hypothesis.** Computing the input on which original and alternative disagree solves
the grouping problem *and* the reporting problem at once.

**Reasoning.** `size < 2` and `size <= 1` are the same predicate. Any scheme that keys
findings on the *edit* reports them twice; a scheme that keys on the *distinguishing
input* cannot. And the same value is what a developer needs to read: "size = 1 is not
constrained" rather than "constant 1 mutated to 2".

**Design.** `src/mutation/behaviour.ts` generates at most two probes per comparison:

- **at the threshold** — relax the operator; distinguishes `lhs = k`
- **past the threshold** — shift the literal outward; distinguishes `lhs = k ± 1`

plus lower-confidence probes for logic, arithmetic and standalone constants. Oblique
sites (`reduce()` seeds, `??` fallbacks) are excluded by construction, and array indices
are skipped because mutating them produces crashes rather than behaviour changes.
Equality against a literal shifts the literal rather than flipping the sense, because
`=== → !==` differs for every input and cannot be named.

**A consequence worth stating.** Naming the input makes a false positive cheap. A
developer reading `status = 600` dismisses it in one second without needing the tool to
have proved anything. POC-01 spent its effort trying to prove equivalence; POC-02 spends
it on making proof unnecessary for triage.
