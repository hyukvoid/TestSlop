# TestSlop

**Your agent changed this logic and the suite is green. Here is the decision nothing verifies.**

Coverage tells you what ran. TestSlop asks what was actually verified.

> Status: **POC-01**. Research prototype. Not published, not production ready.
>
> POC-01 measured the original thesis against an independent coding agent and it
> did not hold. The project pivoted as a result. Read
> [docs/POC-01-REPORT.md](docs/POC-01-REPORT.md) for what changed and why,
> [docs/POC-00-REPORT.md](docs/POC-00-REPORT.md) for the earlier phase, and
> [docs/EVIDENCE-LOG.md](docs/EVIDENCE-LOG.md) for the experiment record.

---

## The problem

A coding agent fixes your bug and adds tests. The tests are green, the assertions
look exact, coverage is up, every linter is happy. Here is a real example from an
independent agent asked to reject invalid reservation quantities:

```ts
// src/inventory.ts
if (!Number.isInteger(quantity) || quantity <= 0) {
  throw new ValidationError("quantity", "quantity must be a positive integer");
}
```

```ts
// src/inventory.test.ts
it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects a non-positive integer quantity: %s",
  (quantity) => {
    expect(() => inv.reserve("TOOL-1", quantity)).toThrow(ValidationError);
    expect(inv.available("TOOL-1")).toBe(10);
  },
);
```

Five inputs, exact error type, and a check that stock was untouched. Most
reviewers would approve this, and they would be missing something:

**nothing reserves exactly 1.** The implementation could reject every quantity-1
reservation and the entire suite would stay green. TestSlop proves it by flipping
`<= 0` to `<= 1` and observing that nothing fails.

Across 24 such tasks, an independent agent left a decision like this unverified in
**27% of them** ??while writing 301 assertions of which **none** were weak.

## What it does

```bash
testslop scan                          # what did the agent just do?
testslop scan --base main              # review a whole branch
testslop scan --base HEAD~1 --mutate   # verify the changed behaviour
testslop scan --json                   # machine-readable output
```

```
HIGH  changed-logic-survived [verified by experiment]
      src/inventory.ts:34
      reserve

      Changed logic in `reserve` was deliberately broken and the tests stayed green.

      Mutations that survived (1):
      src/inventory.ts:34   <= 0  ->  <= 1   (boundary)

      Result:
      test suite passed under every mutation above

      Nothing in the tests that changed alongside this code verifies the boundary
      of `quantity <= 0`. This is an executed result, not an inference.
```

The static rules run in 3 ms and need no test execution. `--mutate` takes about
12 s and produces executed evidence.

## Two kinds of finding

TestSlop deliberately has no "error" class. Static analysis of a diff cannot prove
a test is wrong.

- **`evidence`** ??backed by an executed experiment. A mutant survived; that is a
  fact about your suite.
- **`review`** ??a judgement call for a human, always printed with the before/after
  so you can disagree with it.

## The static rules

They cost 3 ms and catch things mutation cannot see, because the suite is green
before and after.

| Rule | What it means |
| --- | --- |
| `assertion-weakened` | An assertion now accepts more behaviour than before |
| `expected-chasing-implementation` | A test expectation moved in lockstep with the constant it pins, and is provably derivable from the new code |
| `test-disabled` | A running test became `skip` / `todo` / `failing` in this change |
| `assertion-removed` | A test kept its name and lost assertions |
| `weak-new-test` | A new test names a behaviour and then does not check it |
| `snapshot-replaced-assertion` | Explicit expectations traded for a snapshot |
| `test-only-production-path` | Production code gained a branch that behaves differently under test |
| `self-derived-oracle` | The expected value is computed by the code under test |
| `exception-broadened` | A specific error expectation became a broad one |
| `coverage-ignore-added` | Coverage rose because code stopped being measured |
| `test-removed` | A file lost test cases without replacing them |

`testslop rules` prints the list with, for each rule, the reason an existing
linter cannot report it.

## Honest results

From [docs/POC-01-REPORT.md](docs/POC-01-REPORT.md), including the parts that do
not flatter the tool:

| | |
| --- | --- |
| Independent-agent tasks where mutation found an unverified decision | **27%** |
| Independent-agent tasks where the **static rules** found anything | **0%** |
| Weak assertions that agent wrote, out of 301 | **0** |
| Surviving mutants that were equivalent mutants (false positives) | **26%** |
| Real commits on which `expected-chasing-implementation` has ever fired | **0 of 762** |
| Agents observed gaming the detector | **0** |

The original premise ??that agents routinely weaken assertions to get green ??did
not survive contact with a strong independent agent. What replaced it is narrower
and better evidenced.

## Why not a linter

Measured on this repository's corpus with **every** `eslint-plugin-jest` rule
enabled and the fixtures presented as jest globals so nothing is handicapped:

|  | TestSlop | eslint-plugin-jest |
| --- | --- | --- |
| Findings on 19 deliberately degraded diffs | 28 | 130 |
| Findings on 13 clean diffs that mimic them | **1** | **81** |
| Clean diffs it fired on | 1 / 13 | 13 / 13 |

ESLint is not bad at its job, it is answering a different question. It reports
properties of a snapshot, identically whether the diff improved your suite or
gutted it.

## Why not Stryker

Stryker asks "how good is this suite?" over a whole project, in minutes to hours,
and reports a score. TestSlop asks "do the tests that changed alongside *this line*
notice when it is wrong?", in seconds, and reports a sentence. Scoping to changed
lines is the whole difference, and it is what makes each survivor interpretable.

## Noise

Across **424 real commits** from five mature repositories (axios, immer, ky,
redux, zustand), selecting only commits that changed both test and production
code:

- **5%** of commits produced any finding
- **0.09** findings per commit
- **1.9** high-severity findings per 100 commits

Every rule in the default set was cut back or rewritten because of a false
positive found in real history — nine distinct classes in POC-00, plus five
assertion-lattice corrections in POC-01. Each has a regression test naming the
commit that exposed it.

## Install and run

Requires Node 20+. Nothing is published; run it from a clone.

```bash
npm install
npm test                  # 174 analyzer tests
npm run corpus:build      # materialise the corpus as real git repos
npm run evaluate          # score the analyzer against the corpus
npm run lint:compare      # rerun the eslint comparison
```

Reproducing the POC-01 experiments (requires the `codex` CLI, authenticated):

```bash
node --experimental-strip-types scripts/agent-bench.ts            # 24-task benchmark
node --experimental-strip-types scripts/agent-bench.ts --weak      # style-contagion arm
node --experimental-strip-types scripts/agent-bench-control.ts     # harness positive control
node --experimental-strip-types scripts/agent-mutation.ts          # mutation on agent diffs
node --experimental-strip-types scripts/agent-gaming.ts            # adversarial loop
node --experimental-strip-types scripts/survey-assertions.ts       # assertion API survey
node --experimental-strip-types scripts/agent-report.ts            # base rate
```

```bash
# scan a repository
node --experimental-strip-types src/cli.ts scan --cwd /path/to/repo --base main
```

Python/pytest is supported through a second adapter, which exists mainly to prove
the language boundary holds. `assertion-weakened` and friends work on pytest
files; see the report for what is and is not covered.

## Limits you should know before trusting it

- **26% of surviving mutants are equivalent mutants** — behaviourally unreachable
  changes like `status < 600` becoming `<= 600`. This is the biggest open precision
  problem and gates shipping `--mutate` on by default.
- **Supported assertion APIs**: Jest/Vitest `expect`, chai (`expect().to` and
  `should`), pytest `assert`. **Not** ava, `node:assert`, tape or uvu. On an
  unsupported file TestSlop says so explicitly rather than reporting a clean scan.
- **Golden values are undetectable in principle.** If a test pins a value obtained
  by running the implementation, it looks maximally strong and no static analysis
  can tell. Only an independent specification settles it.
- `expected-chasing-implementation` is a **correlation**, deliberately, and has
  fired on zero of 762 real commits. It is kept for the reason given in the POC-01
  report, not because it has measured yield.
- **Suites generated by a runtime loop** (`for (…) { it(…) }`) parse as a single
  test case.
- **Path classification is over-inclusive**: fixture and entity files under
  `test/` are counted as discovered tests, which understates coverage.
- tsconfig path aliases are not resolved, so cross-file rules rely on relative
  imports or filename convention.
- No rule can prove a test is wrong, and none claim to.

Full list: [docs/POC-01-REPORT.md](docs/POC-01-REPORT.md#l-known-limitations).

## Layout

```
src/core        change collection, pairing, linking, coverage, pipeline, types
src/adapters    ts/ (Jest + Vitest + chai), python/ (pytest)
src/rules       one file per rule family
src/mutation    targeted mutation operators and runner
src/report      human and JSON reporters
corpus/         evaluation corpus, agent benchmark tasks, manual review verdicts
scripts/        corpus builder, scoring harness, real-history harness,
                agent benchmark, mutation harness, surveys, metrics
test/           analyzer tests, pairing benchmark, chai and coverage tests
docs/           architecture, POC-00 report, POC-01 report, evidence log
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the pipeline and the
assertion strength model. [docs/EVIDENCE-LOG.md](docs/EVIDENCE-LOG.md) records every
POC-01 hypothesis, experiment and decision in order, including the ones that went
against the product.
