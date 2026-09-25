# Architecture

## Pipeline

```
git repository
      |
      v
change collector          src/core/changeset.ts   + src/core/git.ts
  base..head file list, full content at both revisions, touched line numbers,
  test-vs-production classification
      |
      v
language adapters         src/adapters/ts/  src/adapters/python/
  test files      -> TestFileModel   (cases, assertions, mocks, imports)
  production files-> ProductionFileModel (value-bearing signals, return exprs)
      |
      v
linker                    src/core/link.ts
  changed test file -> production files it exercises
      |
      v
rule engine               src/rules/*.ts
  12 rules over the normalised model, before and after side by side
      |
      v
dedupe + sort             src/core/pipeline.ts
  one edit produces one story
      |
      v
optional mutation         src/mutation/
  mutate only changed production lines, run only the related changed tests
      |
      v
reporters                 src/report/human.ts  src/report/json.ts
```

Two properties are load-bearing:

**Adapters parse content, not files.** Every parser takes `(path, content)` and
never touches the filesystem or imports the code under analysis. This is what
allows the *base revision* of a file to be analysed at all — it no longer exists
on disk. It also means a scan cannot execute a user's production code, which
matters when the input is an agent-generated diff.

**Rules never see a language.** Everything downstream of the adapters works on
`TestFileModel` / `ProductionFileModel`. Adding pytest required a new parser pair
and zero changes to any rule. That claim is tested rather than asserted: case
`a13-pytest-assertion-weakened` is the pytest translation of the flagship
TypeScript case, and it is detected by the same rule.

## The assertion strength lattice

`src/adapters/ts/strength.ts`

Every diff-aware rule reduces to one question: *did this assertion start
accepting more behaviour than it did before?* So strength is modelled as the size
of the set of program behaviours an assertion still admits, as an ordinal scale
over specificity classes:

```
NONE        no assertion
VACUOUS     cannot meaningfully fail            not.toBe(3)
OPAQUE      runs but pins nothing reviewable    toMatchSnapshot()
EXISTENCE   only rules out absence/falsiness    toBeDefined()
TYPE_ONLY   restricts to a type                 toBeInstanceOf(Error)
CONSTRAINED restricts to a range or pattern     toBeGreaterThan(0), toMatch(re)
STRUCTURAL  pins part of a value's shape        toMatchObject({ a: 1 })
EXACT       admits exactly one value            toBe(401), toBeNull()
```

An ordinal scale is enough because the only operation needed is comparison of two
classifications of the *same subject*. No rule needs to know how much weaker one
assertion is than another, only that it is.

### Why the naive version is wrong

Four cases forced the classifier to reason per-matcher rather than scoring
matcher names, each one discovered as a false positive on real code:

| Looks like | Actually is | Found in |
| --- | --- | --- |
| `toBeNull()` — an existence check like `toBeDefined()` | **EXACT**: it pins one value | reasoning |
| `not.toHaveBeenCalled()` — a negated existence check | **EXACT**: it pins the call count to zero | axios |
| `not.toBe(someObject)` — vacuous, admits everything else | **CONSTRAINED**: the canonical "this is a copy" assertion | immer |
| `toThrowErrorMatchingInlineSnapshot()` — a structural snapshot | **CONSTRAINED error check**: a message assertion whose text is generated | immer |

Negation in particular cannot be handled by flipping a score.
`not.toBe(3)` admits every value but one and is nearly vacuous;
`not.toHaveProperty('cause')` is a precise absence claim; `not.toBeDefined()` is
exactly `toBeUndefined()`. Each is resolved individually.

### Assertion pairing

`src/rules/assertion-weakened.ts`

To compare an assertion across revisions it has to be matched to its
counterpart. Two passes:

1. **Identical normalised subject expression.** `expect(response.status)` in both
   revisions is the same assertion. Normalisation strips whitespace and `await`.
2. **Positional, when subjects share a root identifier.** Agents often rename a
   local while weakening a matcher. Findings paired this way carry an 0.18
   confidence penalty and print `paired by position; subject expression also
   changed` so a reviewer can discount them.

Test cases are matched by their describe > ... > test title. Renaming a test breaks the pairing, and parameterised suites with reused titles can collide.

## Cross-file correlation

`src/rules/expected-chasing-implementation.ts`

The production adapter extracts *value-bearing signals* — numeric and string
literals, comparison and logical operators, return expressions, conditionals,
throws — grouped by enclosing function. Comparing that fingerprint across
revisions identifies which decisions the author changed.

When a linked test file also changed a numeric expectation, the rule asks whether
the new expectation is **arithmetically derivable** from the new implementation:

```
expectedAfter == expectedBefore * (constAfter / constBefore)   scaled
expectedAfter == expectedBefore + (constAfter - constBefore)   shifted
expectedAfter == constAfter                                    adopted
```

For `0.12 -> 0.10` in production and `120 -> 100` in the test, the scaled form
holds exactly. That is the signature of "run the new code and write down what it
printed", and it is the difference between a vague co-change warning and a
finding worth reading. When no derivation holds the finding drops from high to
medium and says so.

Linking is by relative import resolution first, filename convention second.
tsconfig path aliases are not resolved.

## Targeted mutation

`src/mutation/`

```
1. baseline: run the changed tests unmutated
     not green  ->  stop, report why; surviving mutants would mean nothing
2. generate mutants on production lines the diff touched, boundary operators first
3. per mutant: write, run only the changed tests linked to that file, restore
4. survivors, grouped per enclosing function, become `evidence`-class findings
```

Operators: boundary (`>=`/`>`), equality, logical, arithmetic, numeric off-by-one,
boolean flip. Boundaries run first because a missing boundary test is the gap
agent-written tests most often leave.

Scoping to changed lines is what makes this different from running Stryker. The
mutant set drops from "the whole program" to "the decisions in this commit",
which is usually single digits, and every survivor is attached to code the author
just wrote.

Safety: original file contents are captured in memory before the first mutation
and restored in a `finally`, plus a synchronous restore on `SIGINT`/`SIGTERM`. A
mutant whose file has drifted from the analysed revision is skipped rather than
applied.

## Finding classes

There is deliberately **no `error` class**. Static analysis of a diff cannot prove
a test is wrong.

- `review` — a judgement call for a human, with before/after evidence attached so
  the human can disagree
- `evidence` — backed by an executed experiment; currently only surviving mutants

Severity (`high`/`medium`/`low`) is about how much it matters. `confidence` is the
documented precision expectation of the detector, adjusted per finding.

## Deduplication

Rules overlap by design — several look at the same transition from different
angles. `src/core/pipeline.ts` suppresses the less specific of two findings at the
same location, so `toThrow(InsufficientFunds)` becoming `toThrow()` is reported
once, by `exception-broadened`, rather than twice.

## Dependencies

| Dependency | Why | What TestSlop adds |
| --- | --- | --- |
| `typescript` | Parser for TS/JS/TSX in single-file mode, no program or type checker needed | The assertion model, the strength lattice, the diff comparison |
| `git` CLI | Five operations: `rev-parse`, `merge-base`, `diff --name-status`, `diff --unified=0`, `show`, `ls-tree` | Role classification, hunk-to-line mapping, two-revision content pairing |
| Python stdlib `ast` | pytest adapter, no third-party package and no need for pytest to be installed | Same lattice, same rules |
| `vitest` (dev) | Analyzer's own tests, and the runner driven during mutation | — |
| `eslint` + `eslint-plugin-jest` (scratch only) | The competitive comparison in `scripts/lint-compare.ts`; installed into `work/`, not a project dependency | — |

Arg parsing uses `node:util parseArgs`; colour handling is ~15 lines in
`src/report/human.ts`. Neither justified a dependency.

---

## Additional analysis details

### Test-case pairing

`src/core/pairing.ts`

Every diff-aware rule needs to know which before-case corresponds to which after-case. Exact-title matching alone misses a renamed test whose assertion is also weakened, treating it as an unrelated delete plus add.

Five layers, most certain first, each required to be unambiguous:

```
1  exact-title       identical describe path + title                 confidence x1.00
2  identical-body    normalised body matches, title changed          confidence x1.00
3  leaf-title        same title, describe path changed               confidence x0.95
4  structural        mutual-best similarity above a margin           confidence x0.80
5  singleton         one unmatched case each side, small file        confidence x0.70
```

Layer 4 weights subjects 0.55, production calls 0.30, title tokens 0.15. Subjects
dominate because `expect(response.status)` surviving a matcher change is exactly the
signal `assertion-weakened` needs, and it is the component least likely to coincide
between genuinely different tests. Expected *values* are deliberately excluded from
the similarity, since weakening changes them.

A candidate must clear 0.60, beat the runner-up by 0.15, and be the mutual best match
in both directions. **A wrong pairing is worse than no pairing**: it invents a
before/after relationship and can manufacture a high-severity finding from two
unrelated tests. Every finding derived from a non-exact basis is confidence-discounted
and prints the basis in its evidence block.

Pairing is computed once per file in `buildContext` and shared through
`AnalysisContext.pairings`, so all rules agree on identity and cross-rule
deduplication stays coherent.

### Chai

`src/adapters/ts/chai.ts`

Selected over ava on measured evidence: 39.4% of surveyed test files versus 1.6%.

The module does one thing — translate a chai chain into the canonical matcher
vocabulary the Jest classifier already understands:

```
expect(x).to.equal(1)      ->  toBe        + args
expect(x).to.deep.equal(1) ->  toEqual     + args
expect(x).to.be.true       ->  toBe        + synthetic [true]
expect(x).to.exist         ->  toBeDefined
expect(x).to.be.empty      ->  toHaveLength + synthetic [0]
expect(spy).to.have.been.calledWith(1)  ->  toHaveBeenCalledWith + args
```

There is still **one** strength lattice, and no rule contains a chai branch. Property
terminals (`.to.be.true`) carry their expected value in the property name, so it is
materialised as a synthetic argument — otherwise the lattice could not see that the
assertion pins exactly one value.

Two extraction passes are needed because `.to.be.true` is not a call expression. The
Jest extractor rejects any chain containing a chai connector (`to`, `be`, `have`, …);
without that guard both extractors claim `expect(x).to.equal(1)` and the Jest one wins
with a meaningless `STRUCTURAL`.

### Analysis coverage

`src/core/coverage.ts`

Computed per scan and consumed by both reporters. When `complete` is false — a changed
test file yielded no analysable assertion — the human reporter replaces its green
headline with a warning and the JSON sets `analysisComplete: false`.

This guards against a misleading clean result: a scan can parse many test cases
while analyzing zero assertions. The report makes incomplete analysis explicit.
