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
