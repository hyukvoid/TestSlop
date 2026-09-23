# TestSlop evidence log

Chronological record of POC-00 through POC-02 hypotheses, experiments, results and decisions. Written
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
---

## E14 — Which external repositories can actually be verified

**Hypothesis.** Any small, well-tested npm package can serve as an external validation
target, since verification only needs a diff and a test runner.

**Experiment.** Cloned ten repositories the author did not write — `bytes`, `ms`, `qs`,
`semver`, `nanoid`, `camelcase`, `deepmerge`, `slugify`, `dateformat`, `validator` — and
tried to establish a green baseline and a working test command on each.

**Result.** The first surprise was the runner spread: only `ms` uses jest. `bytes`, `qs`
and others use mocha; some use tape or `node:test`. POC-01's analyser supported vitest,
jest and pytest assertion APIs, which would have excluded most of this set.

Verification does not need that support. It needs a diff and a command that exits
non-zero when a test fails. Runner detection was widened to mocha/ava/tape/`node:test`,
and no assertion-API work was required.

`validator.js` was dropped for a different reason: its suite imports a built bundle, so a
missing `npm run build` and a genuinely failing task are indistinguishable. A task whose
failure mode is ambiguous cannot be evidence. `ms` was substituted.

**Decision.** The runner requirement is the real portability constraint, and it is much
weaker than the assertion-API requirement. This removes POC-01's single biggest coverage
limitation — but it was discovered by trying, not predicted.

---

## E15 — Goal C's agent arm, blocked mid-experiment

**Hypothesis.** Running the one available agent on tasks in external repositories would
show whether the POC-01 findings depend on the author's own code style.

**Experiment.** Defined six pre-registered tasks (X01–X03 on `bytes`, X04–X06 on `ms`)
and ran them through the same harness used in POC-01.

**Result.** All six recorded `agent-failed` with empty diffs. Codex reported
`You've hit your usage limit`, resetting at 6:44 PM — roughly seven hours out. Claude was
already at `402 insufficient_quota` for the month (E11). Raw records are kept in
`work/extbench-results/*.json` so the failure is inspectable rather than asserted.

The feedback-loop experiment (show a finding to the agent, see whether it strengthens the
test or games the check) has the same dependency and is blocked for the same reason.

**Decision.** Do not substitute a fake second arm. Two goals that require an agent are
recorded as blocked, and external validity is pursued through the one avenue that needs
no agent: real human commits already in these repositories' histories.

---

## E16 — A reused sandbox made the tool non-deterministic

**Hypothesis.** Reusing one scratch directory per repository is a safe optimisation,
since every run overwrites the files it cares about.

**Experiment.** Ran the external history benchmark twice over the same 18 `bytes`
commits.

**Result.** Run one reported 2 commits with unverified behaviour. Run two reported 0. The
inputs were identical.

The sandbox is keyed on the analysed repository path, but a history walk checks out many
different commits at that path. Copying in the new revision overwrote the files that
existed in both revisions and left behind files the new revision had deleted — including
older test files, which kept passing and masked the survivors.

This is the failure the brief warns about in its plainest form: a zero that looks like
success and is actually the analyser not doing the work. It was caught only because the
run was repeated.

**Fix.** Clear every sandbox entry except `node_modules` before copying, keeping the
install cache that makes the warm path fast. Two regression tests were added: one that a
reused sandbox does not retain files the new revision lacks, one that verification never
writes to the analysed repository.

**Re-check.** Two further runs over the same 18 commits now agree exactly — 10
verification available, 8 baseline red, 2 unverified findings, 278 alternatives generated,
43 after dedup, 37 executed, same two findings. Only wall time differs (6.3s vs 5.2s mean).

**Decision.** Repeat every measurement at least once before reporting it. Caching that is
keyed on a path is unsafe whenever the thing at that path changes identity.

---

## E17 — Does the pivot actually beat POC-01's mutation pass?

**Hypothesis.** Behaviour-keyed alternatives with distinguishing inputs produce fewer and better findings than POC-01's operator-keyed mutation on the same inputs.

**Experiment.** Ran both over the identical 22 agent diffs from POC-01. Nothing about the diffs changed; only the analyser did.

**Result.**

| | POC-01 | POC-02 |
|---|---:|---:|
| alternatives generated | 93 | 250 |
| after deduplication | — | 73 (71% fewer than generated) |
| executed | 93 | 69 |
| survivors / unverified | 19 | 12 |
| tasks with unverified behaviour | 11/22 | 9/22 |
| mean wall time per task | 12.4s | 8.2s |

Manual classification of the POC-02 survivors: 5 clear true positives, 3 useful review findings, 1 strictly equivalent, 1 out-of-contract, and 2 out-of-domain. Thus 8/12 survivors (67%) were useful, across 7 tasks. The full classifications are in corpus/poc02/manual-findings.md.

E12 revised POC-01's original equivalent count: only 2/19 were strictly equivalent (10.5%), not the earlier 5/19 (26%). POC-02's strict equivalent count is 1/12 (8.3%). The grouping reduction is substantial; the strict-equivalence improvement is small and based on a small sample.

One input label also needs correction by manual review: the T17 ratios-length alternative is displayed as ratios.length = 0, but the useful missing case is a singleton list. The empty-list test still sees a RangeError through a later guard. This is an interpretability limitation, recorded in the manual review.

**Honest reading.** The useful signal and lower noise are present on the author's own corpus. This experiment does not establish external validity.

**Decision.** Report the improvement with its source and limitations. Do not treat an author-built benchmark as external validation.

---

## E18 — Confidence labels do not separate signal from noise

**Hypothesis.** The high/medium/low label derived from probe kind predicts whether a finding is useful.

**Experiment.** Cross-tabulated the labels against manual classifications of the 12 POC-02 survivors, then compared the external findings available by the end of POC-02.

**Result.** Six of nine high-confidence findings in the authored corpus were useful (67%), the same rate as all 12 findings. The later ms history run produced one high-confidence year-boundary survivor that was manually useful. The gpt-6-sol external task run produced one high-confidence survivor at ms = 0 that was strictly equivalent. These external samples are too small to estimate a ranking rate.

**Decision.** Keep confidence as a description of how a probe was derived, not as a usefulness ranking or filter. Its ability to predict usefulness remains unproven.

---

## E19 — External history experiments

**Hypothesis.** Real human commits in repositories the author did not create can exercise changed-behaviour verification.

**Experiment.** Walked public bytes and ms histories, selecting commits that changed production and test code. The latest matching records are work/exthist-bytes.json plus work/eh-bytes-v2.txt, and work/exthist-ms.json plus work/eh-ms-v2.txt. These runs are exploratory, not held-out: bytes was used to tune mutation filters, and neither repository was reserved before the first external inspection.

**Result.** On bytes, the latest matching records cover 18 candidates, 8 with usable baselines, 197 alternatives generated, 37 deduplicated, 31 executed, and 0 unverified. Ten candidates were unavailable for a mix of red baselines and no alternatives. Mean verification time was 6.0s for the usable commits. An earlier run claimed two findings; that claim is withdrawn because it does not match the later raw JSON and summary.

On ms, the latest matching v2 records cover 14 candidates, 2 with green baselines, 75 alternatives generated, 8 deduplicated and executed, and 1 unverified. Twelve candidates were unavailable. Mean time for the two usable commits was 12.8s. The one survivor is commit 3ba274e015722cbe1cdaa40f14f8c2954d8df0f3, “add support for months”: changing msAbs >= y to > survives at an exact one-year input. The commit's year tests use year + 1 and omit the exact threshold; at exactly one year, the result moves from 1 year to the month branch. Manual review classifies this as a useful external true positive.

Earlier summaries disagree: an older ms text file reports 12 candidates and no usable baseline, while the later structured run and its matching v2 summary report 14 candidates and 2 usable baselines. The later matching pair is reported here; the older result remains archived and is excluded.

**What this is and is not.** The ms result is one useful survivor in two usable commits from one repository; it is not a stable estimate of external precision. The bytes sample produced no survivor and had 8/18 usable baselines. The higher survivor counts from qs and camelcase are development data because those repositories directly shaped operator filters; they are excluded from held-out success metrics.

**Decision.** External human history can expose a useful boundary gap, but coverage and evidence consistency are too limited for a public-release claim. Preserve the ms case as exploratory corroboration and keep external validation open.

---

## E20 — Independent Claude external-agent arm (pre-registered)

**Hypothesis.** The useful-survivor signal is not unique to the Codex/gpt-5.6-luna run.

**Selection before dispatch.** Run four already-registered requests unchanged: X01 (bytes feature), X02 (bytes bug fix), X05 (ms rounding behaviour change), and X06 (ms negative-duration bug). This spans both external repositories and feature/bug/behaviour-change tasks without mentioning boundaries or TestSlop. Run Claude Code with the explicit `claude-sonnet-4-6` model, cap each print-mode run at the CLI's $2 budget, and save its raw output under a separate results directory so failed Codex records remain intact.

**Availability check.** Claude Code 2.1.88 is installed and `claude auth status` reports an authenticated session. This differs from E11's earlier 402 quota result; no inference about sustained quota is made before the runs.

**Result.** The first dispatch recorded all four attempts, but each exited in 7–9 seconds with no diff and the same CLI response: the selected `claude-sonnet-4-6` model was not available to this account. The baseline suites were green (30 tests on `bytes`; 167 on `ms`). No mutation result is claimed from these attempts.

**Decision.** Treat the model-selection error as an infrastructure failure, not an agent outcome. Preserve these raw records and make one same-task retry using the CLI's documented `sonnet` alias, with the same $2 per-task cap. This is not a retry based on the quality of any result.
---

## E21 — Claude external-agent retry after model-selection failure (pre-registered)

**Hypothesis.** A second independent coding agent will naturally produce useful green-test diffs on the external repositories.

**Experiment.** Re-run the same four pre-registered tasks (X01, X02, X05, X06), unchanged, under Claude Code's documented `sonnet` model alias. Preserve the explicit-model failures in their own result files, place alias results under a separate model directory, and retain the $2 per-task budget cap. The retry is justified only by the CLI rejecting the explicit model ID before any task diff was made.

**Result.** The four alias attempts exited in 4.4–5.2 seconds with Anthropic `402 insufficient_quota` for the month. All produced empty diffs; the original suites remained green (30 tests on `bytes`; 167 on `ms`). The harness stopped as preregistered and did not try another model spelling.

**Decision.** Claude Code is installed and authenticated but cannot currently execute the benchmark because the account quota is exhausted. The second-agent goal remains unmeasured. Keep the empty-diff records as infrastructure failures; do not count them as completed agent tasks or evidence about agent behaviour. The feedback-loop arm is likewise unavailable.
---

## E22 — Reconcile external-history records and add a held-out repository

**Hypothesis.** Reconcile the exploratory bytes/ms records and check whether the verifier generates alternatives on a repository that did not shape the mutation operators.

**Integrity check.** For bytes, the newest matching raw JSON and v2 text summary agree on 8/18 usable commits and zero unverified findings. An older final summary says 9/18 usable, also with zero findings; an earlier record claimed two findings. Withdraw the positive bytes claim. For ms, the later v2 JSON and matching summary agree on 2/14 usable commits and one survivor; an older summary says 0/12. E19 records the later matching pair and preserves the older output as inconsistent.

**Pre-registration.** Use validator.js (https://github.com/validatorjs/validator.js, HEAD 9ff342479591ca5a43cb30000195bcf55c1bbed9) as a repository not used to tune behaviour operators. It was screened earlier and dropped because its tests import a built bundle; address that with npm run build && npm run test:ci. First select the newest 18 non-merge commits touching both production and test files. The build/test command at pinned HEAD took about a minute, so cap the history run at the newest three eligible commits and three alternatives per commit before reviewing mutation output. The first scan found no commits because the clone was shallow; fetch public history without moving HEAD and rerun that fixed selection.

**Result.** The pinned HEAD build and test command passed 323 tests. After fetching the missing history, the three preselected commits were:
- a79ff980: accept Spanish VAT digit controls
- cdb7dafc: export the real toString implementation
- 65a070c9: add Indian PAN tax ID support

All three had no behavioural alternatives on the changed lines. Each produced zero generated, deduplicated, or executed mutations. The verifier returned before running a historical baseline; this is a generator-coverage miss, not evidence that those commits had adequate tests. Raw records are in work/exthist-validator.json.

**Decision.** The held-out sample does not validate external precision. It shows the current operator set found nothing on three real validation changes. Combined with one exploratory ms history finding, this is insufficient evidence for public v0.1.

---

## E23 — Second Codex model on external tasks

**Hypothesis.** The changed-behaviour signal seen on POC-01's Codex/gpt-5.6-luna tasks also appears on ordinary tasks against public repositories when a different available coding model implements them.

**Selection before dispatch.** Run the same four external tasks selected for E20/E21: X01 and X02 on `bytes`, X05 and X06 on `ms`. Keep the prompts unchanged. Use the available Codex CLI with explicit model `gpt-6-sol`, and store results under `work/extbench-results-codex/gpt-6-sol/`, separate from the earlier config-default Codex run and both Claude attempts. Materialize only Git-tracked public files from the pinned upstream snapshots; exclude `.npmrc` and local artifacts. No task tells the agent about TestSlop, mutation, or boundary testing. The Codex CLI exposes no per-task dollar cap in this harness, so do not claim a monetary cap; record any account or execution failures as infrastructure outcomes.

**Result.** All four agent invocations completed with green repository test commands: X01/X02 on `bytes` (30 passing each), X05 on `ms` (168 passing), and X06 on `ms` (182 passing). Source review found the two `bytes` task premises already satisfied at the pinned upstream revision: pebibytes were supported, and negative unit strings were already parsed (existing tests included `-1.5TB`). X01 changed only tests/docs; X02 refactored the regex and added tests, but the requested behavior was not missing. Neither produced a usable mutation-verification sample.

X05 and X06 implemented their requested `ms` behavior and added positive/negative boundary cases. The verifier generated 39 / 33 alternatives and deduplicated to 2 / 3, but executed none because the linked-test baseline exited 1. Both full suites were green. Reproducing X05's filtered command showed both changed suites passed (87 tests), then Jest exited 1 because global coverage was 98.38%, below the repository's 100% threshold. This is a test-selection / global-coverage incompatibility, not a red task baseline. The results are retained as completed agent tasks, but no survivor rate is claimed until the verifier fallback is replayed.

**Decision.** A different Codex model can implement two valid external tasks with green full suites, but this does not establish cross-provider replication. Preserve the two task-premise mismatches and fix the filtered-baseline failure before using X05/X06 to assess mutation precision.

---

## E24 — Full-suite fallback when targeted tests fail global checks

**Hypothesis.** A filtered changed-test run can exit nonzero because of repository-wide checks such as coverage thresholds even when the selected tests and full baseline suite pass.

**Selection before replay.** Kept the completed ms diffs from E23 (X05 rounding and X06 negative rounding) unchanged. Added a regression test with a temporary repository where filtered runs fail a simulated global check but the full suite passes and catches the mutations. Replayed only the exact X05/X06 diffs; no agent was rerun and no prompt changed.

**Result.** The regression test passed. The first replay showed the targeted baseline failing and the full-suite fallback also exiting nonzero. Running that full-suite command in X05's scratch sandbox showed Jest could not find the ts-jest preset because the analyzed repository's node_modules was itself a junction and the sandbox did not expose the nested dependency link. The original E23 raw records and failed E24 replay are preserved.

**Decision.** The fallback logic works in the isolated regression, but replaying external worktrees also requires resolving nested dependency links. E25 addresses that separate harness failure.

---

## E25 — Resolve nested dependency links in sandboxes

**Hypothesis.** Resolving a repository's `node_modules` junction to its actual directory before creating the sandbox link will preserve external dependencies in the scratch copy.

**Experiment.** Updated sandbox creation to resolve the dependency path before linking it. Added a regression test where the analyzed repository's `node_modules` is a junction, asserted the dependency is readable in the sandbox, disposed the sandbox, and asserted the source dependency remains intact. Replayed the exact X05/X06 diffs, with the same upstream commits and raw agent outputs. Neither coding agent was rerun.

**Result.** The nested-junction regression passed. The verifier now ran the full suites after targeted baseline exits caused by Jest's repository-wide coverage threshold. X05: 39 generated, 2 deduplicated, 2 executed, both caught; verifier wall time 9.97s. X06: 33 generated, 3 deduplicated, 3 executed, 2 caught and 1 survivor; verifier wall time 16.01s. Both full-suite baselines were green. The original agent suites passed 168 tests (X05) and 182 tests (X06).

Manual classification of the X06 survivor: high-confidence `ms < 0 -> ms <= 0`, distinguished at `ms = 0`, in the private `round(ms, n)` helper. Public callers invoke that helper only after `Math.abs(ms) >= n` for a positive unit, so zero never reaches the mutated condition. The alternative is strictly equivalent for observable public calls, not a missing test boundary. Across these two valid agent tasks: 0 useful survivors / 2 tasks; one equivalent survivor / 5 executed alternatives.

**Decision.** E25 fixes the baseline and nested-dependency failures and makes the replay reproducible. It does not produce a useful external finding in this two-task sample; it produces one equivalent alternative, reinforcing the need for suppression or user-facing separation.

---

## E26 — Feedback on a manually equivalent finding

**Hypothesis.** A coding agent can evaluate a TestSlop finding in domain context and reject an unreachable/equivalent alternative rather than adding a meaningless test.

**Experiment.** Gave the gpt-6-sol agent the X06 `ms = 0` survivor in a separate clone that preserved the original X06 agent diff. Asked it to inspect public call paths and, if the finding was real, add a test that catches it; if it was unreachable/equivalent, explain why without forcing a test or changing behavior. The original agent repo and E25 replay were left untouched.

**Result.** Codex CLI 0.155.1 completed in 116s with exit 0. It found that all public callers reach `round(ms, n)` only inside a unit branch guarded by `Math.abs(ms) >= n`, so `ms = 0` cannot reach the mutated condition. It made no edits and explained why no public API test could kill the alternative. The original X06 diff remained byte-for-byte identical. The feedback clone's Node and Edge suites each passed 182 tests; the runner's full Jest command also passed 182. Its `pnpm test` attempt failed before running because the repository's `pnpm-workspace.yaml` lacks a `packages` entry.

Fresh verification repeated 33 generated, 3 deduplicated, 3 executed, 2 caught, and the same 1 equivalent `ms = 0` survivor. The manually assessed feedback response was correct. One process side effect occurred: the nested Codex CLI ran a PostToolUse hook that delivered the configured ntfy message before the overall POC-02 work was complete. The delivered notification cannot be retracted; no duplicate notification will be sent.

**Decision.** The feedback loop can expose an equivalent finding when the agent follows the call path. The verifier still reports it as a survivor, so equivalent suppression remains unresolved.

---

## E27 — Final local verification and archive integrity

**Experiment.** After updating the POC-02 README and report, ran `npm run typecheck`, `npm test -- --reporter=dot`, `npm run build`, and `git diff --check`. Scanned the versioned raw archive for the private ntfy topic after redacting it from the E26 transcript copy.

**Result.** Typecheck and build passed; all 221 tests passed across 6 files; the diff check passed; the private topic was absent from the archived raw records. The E26 incident remains as documented: its nested CLI hook sent one alert early. No second alert was sent.

**Decision.** Keep the repository as a research archive with the NO-GO release decision. These local checks do not change the external-validation limitations documented above.
