# TestSlop

**Your coding agent made the tests green. Check what changed to get there.**

Coverage tells you what ran. TestSlop asks what was actually verified.

> Status: **POC-00**. Research prototype. Not published, not production ready.
> See [docs/POC-00-REPORT.md](docs/POC-00-REPORT.md) for the evaluation, the
> metrics, and the honest list of what does not work.

---

## The problem

Coding agents are very good at making tests pass. They are not equally good at
preserving the strength of the test oracle. The two most common ways a suite gets
greener without getting better:

```diff
- expect(response.status).toBe(401)
+ expect(response.status).toBeDefined()
```

```diff
  src/tax.ts
- return subtotal * 0.12
+ return subtotal * 0.10

  src/tax.test.ts
- expect(calculateTax(order)).toBe(120)
+ expect(calculateTax(order)).toBe(100)
```

Both diffs leave you with valid, idiomatic, passing tests. Coverage is unchanged
or higher. Every linter is happy. The first test can no longer fail; the second
no longer checks the requirement independently of the code.

Neither is visible in a single snapshot of the code. Both are obvious in a diff.

## What it does

```bash
testslop scan                          # what did the agent just do?
testslop scan --base main              # review a whole branch
testslop scan --base HEAD~1 --mutate   # add behavioural evidence
testslop scan --json                   # machine-readable output
```

```
TestSlop
----------------------------------------------------------

Comparing         HEAD~1...worktree
Changed tests     1 file(s), 2 test case(s)
Changed prod      1 file(s)

----------------------------------------------------------

HIGH  assertion-weakened
      src/auth.test.ts:12
      authenticate > rejects a request with no token

      Assertion on `response.status` weakened from EXACT to EXISTENCE.

      Assertion:
      - expect(response.status).toBe(401)
      + expect(response.status).toBeDefined()

      Previously accepted exactly one value. Now accepts every value except
      undefined.

MED   weak-new-test
      src/auth.test.ts:22
      authenticate > handles an expired token

      New test runs production code but every assertion is an existence-level check.

      Assertions (1):
      + expect(response.status).toBeDefined()   -> EXISTENCE

      This test raises coverage and will stay green across almost any change to
      the code it calls.

----------------------------------------------------------

3 findings need review  (2 high, 1 medium)

Scanned in 19 ms.
```

## What it catches

| Rule | What it means |
| --- | --- |
| `assertion-weakened` | An assertion now accepts more behaviour than before |
| `expected-chasing-implementation` | A test expectation moved in lockstep with the constant it pins, and is arithmetically derivable from the new code |
| `test-disabled` | A running test became `skip` / `todo` / `failing` in this change |
| `assertion-removed` | A test kept its name and lost assertions |
| `self-derived-oracle` | The expected value is computed by the code under test |
| `test-only-production-path` | Production code gained a branch that behaves differently under test |
| `mock-scope-expanded` | A test started mocking the module it is supposed to test |
| `snapshot-replaced-assertion` | Explicit expectations were traded for a snapshot |
| `exception-broadened` | A specific error expectation became a broad one |
| `weak-new-test` | A new test names a behaviour and then does not check it |
| `coverage-ignore-added` | Coverage rose because code stopped being measured |
| `test-removed` | A file lost test cases without replacing them |
| `changed-logic-survived` | The changed logic was deliberately broken and the tests stayed green |

`testslop rules` prints the list with, for each rule, the reason an existing
linter cannot report it.

## Why not a linter

Measured on this repository's own corpus, with **every** `eslint-plugin-jest`
rule enabled and the fixtures presented as jest globals so nothing is
handicapped:

|  | TestSlop | eslint-plugin-jest |
| --- | --- | --- |
| Findings on 19 deliberately degraded diffs | 28 | 130 |
| Findings on 13 clean diffs that mimic them | **1** | **81** |
| Clean diffs it fired on | 1 / 13 | 13 / 13 |

ESLint is not bad at its job. It is answering a different question. It reports
properties of a snapshot — formatting, preferred matchers, a skipped test — and
it reports them identically whether the diff improved the suite or gutted it.
Ten of TestSlop's rules have no `eslint-plugin-jest` counterpart at all, because
they are statements about a transition rather than a state.

## Why not mutation testing

TestSlop uses mutation, but only on the lines the diff touched, and only to
answer one question: *does anything in the tests that changed alongside this code
notice when this specific decision is broken?*

That keeps a full run in the tens of seconds instead of the tens of minutes, and
it makes each surviving mutant interpretable — it is attached to a line the
author just wrote, so the report can name the unverified behaviour instead of
handing over a score.

On the corpus, mutation killed every mutant in the well-tested cases and found
survivors in exactly the under-tested ones. It is a complement to the static
rules, not a replacement: `expected-chasing-implementation` is invisible to
mutation, because the suite is green before and after.

## Noise

Across **424 real commits** from five mature repositories (axios, immer, ky,
redux, zustand), selecting only commits that changed both test and production
code:

- **5%** of commits produced any finding
- **0.09** findings per commit
- **1.9** high-severity findings per 100 commits

Every rule in the default set was cut back or rewritten because of a false
positive found in that history. The full record, including the ones that were
demoted and the one that was removed from the defaults entirely, is in the
[POC report](docs/POC-00-REPORT.md).

## Install and run

Requires Node 20+. Nothing is published; run it from a clone.

```bash
npm install
npm test                  # 96 analyzer tests
npm run corpus:build      # materialise the corpus as real git repos
npm run evaluate          # score the analyzer against the corpus
npm run lint:compare      # rerun the eslint comparison
```

```bash
# scan a repository
node --experimental-strip-types src/cli.ts scan --cwd /path/to/repo --base main
```

Python/pytest is supported through a second adapter, which exists mainly to prove
the language boundary holds. `assertion-weakened` and friends work on pytest
files; see the report for what is and is not covered.

## Limits you should know before trusting it

- **Assertion libraries other than Jest/Vitest expect and pytest assert are not
  modelled.** ky uses ava; TestSlop parsed all 256 of its test cases and analysed
  zero assertions. It now says so in the output rather than reporting a clean
  scan.
- `expected-chasing-implementation` is a **correlation**, deliberately. It is
  reported for review, never as an error.
- No rule can prove a test is wrong, and none of them claim to. Findings are
  `review` or, for executed mutation results, `evidence`.
- tsconfig path aliases are not resolved, so cross-file rules rely on relative
  imports or filename convention.

Full list: [docs/POC-00-REPORT.md](docs/POC-00-REPORT.md#known-limitations).

## Layout

```
src/core        change collection, linking, pipeline, types
src/adapters    ts/ (Jest + Vitest), python/ (pytest)
src/rules       one file per rule family
src/mutation    targeted mutation operators and runner
src/report      human and JSON reporters
corpus/         evaluation corpus definitions
scripts/        corpus builder, scoring harness, real-history harness, metrics
test/           analyzer tests
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the pipeline and the
assertion strength model.
