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

Test cases themselves are matched by `describe > ... > test` title. This is the
weakest part of the design and is documented as such in the report: renaming a
test breaks the pairing, and parameterised suites that reuse a title collide.

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
