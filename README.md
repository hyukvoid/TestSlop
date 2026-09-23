# TestSlop — POC-02 research archive

**Decision: NO-GO for public v0.1.** POC-02 found a useful signal in the authored benchmark, but the evidence does not establish reliable value on independent coding-agent work. This repository preserves the prototype and its experiment record; nothing here is published or released.

## What was tested

TestSlop checks whether tests changed alongside production code would catch nearby behavioral changes. It generates targeted mutations, runs tests against them, and reports surviving alternatives with a distinguishing input. The static rules remain in the prototype, but they did not support the original POC-01 thesis.

On the 22 authored POC-01 task diffs, POC-02 generated 250 alternatives, deduplicated them to 73, and executed 69. Tests caught 57; 12 survived. Manual review classified 5 as clear true positives, 3 as useful review findings, 1 as strictly equivalent, 1 as out of contract, and 2 as out of domain. The 8 useful findings appeared across 7 tasks. Mean runtime was 8.2 seconds per task.

The external evidence was weaker. The two valid second-model tasks produced no useful survivor; one of five executed alternatives was strictly equivalent. An exploratory ms history sample found one useful exact-year boundary gap among two usable baselines. A held-out validator sample generated no alternatives on three selected commits, so it did not measure test strength. These small samples are not pooled into a product precision estimate.

Existing mutation tooling such as StrykerJS overlaps with changed-code mutation and test coverage. TestSlop's remaining distinction is describing a nearby input class in domain language; this POC did not show that difference warrants a public product.

## Run locally

Requires Node 20 or later. This is a research repository, not a published package.

```bash
npm install
npm run typecheck
npm test
npm run build
```

The POC-02 verifier and raw experiment scripts are also retained:

```bash
node --experimental-strip-types scripts/replay-verification.ts
node --experimental-strip-types scripts/external-bench.ts
node --experimental-strip-types scripts/external-history.ts
```

External-agent and repository-history experiments require the relevant CLIs, network access, and their own credentials. Raw captured outputs are archived under `corpus/poc02/raw/`; consult its README before interpreting individual runs.

## Evidence and limitations

- [POC-02 report](docs/POC-02-REPORT.md) — hypotheses, experiments, results, and release decision.
- [Evidence log](docs/EVIDENCE-LOG.md) — chronological experiment record, including failed runs and corrections.
- [Manual finding classifications](corpus/poc02/manual-findings.md) — individual survivor reviews.
- [Equivalence taxonomy](corpus/poc02/equivalence-taxonomy.md) — corrected categories and suppression assessment.
- [Raw evidence archive](corpus/poc02/raw/README.md) — provenance and caveats for captured records.

Survivors still need human review for reachability, contract relevance, and whether the input is in-domain. The verifier can generate no alternatives on changed lines, and its displayed distinguishing input can misdescribe the actionable side of a predicate. The small external samples do not establish general precision or recall. Mutation runs use the developer's privileges and scratch copies are source-protection measures, not a security boundary.

Prior phases remain available in [POC-01](docs/POC-01-REPORT.md), [POC-00](docs/POC-00-REPORT.md), and [architecture notes](docs/ARCHITECTURE.md).
