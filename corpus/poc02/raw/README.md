# POC-02 raw results archive

This directory versions the POC-02 run outputs that were previously under the ignored work/ directory. Task definitions and runner implementations remain in corpus/external-tasks/index.ts, scripts/external-bench.ts, scripts/external-history.ts, scripts/replay-verification.ts, and scripts/feedback-loop.ts.

## Archive map

- verification/ — the main 22-task replay over the POC-01 agent diffs and the weak-style arm. The main JSON and text output are the canonical authored-corpus run: 250 generated, 73 deduplicated, 69 executed, 12 unverified.
- agent-bench/codex-default/ — the six initial X01-X06 Codex runs that failed before producing diffs.
- agent-bench/claude-explicit-model/ — four model-ID attempts that failed model resolution.
- agent-bench/claude-sonnet-alias/sonnet/ — four alias retries that failed with monthly quota exhaustion.
- agent-bench/codex-gpt-6-sol/gpt-6-sol/ — the preregistered four-task second-model sample.
- replays/E24/gpt-6-sol/ — the failed replay before the nested-junction fix; kept for audit.
- replays/E25/gpt-6-sol/ — the successful full-suite replay of the exact X05/X06 diffs.
- feedback-loop/E26-X06.json — the agent response and verifier rerun. The configured ntfy topic is redacted in this archived copy; the original ignored work file is not copied into source control.
- history/raw/ — structured commit-history outcomes for bytes, ms, qs, camelcase, and validator.
- history/summaries/ — the matching v2/final text summaries, including older conflicting bytes/ms summaries so the reconciliation remains inspectable.

## Repository snapshots

| Repository | Upstream HEAD used | Pool and treatment |
|---|---|---|
| bytes | 9ddc13b6c66e0cb293616fba246e05db4b6cef4d | External agent tasks and exploratory history. Mutation filters were tuned against bytes; exclude its history from held-out metrics. |
| ms | 4ff48cec099f0514c3e9bbca18706c9c21122bfb | External agent tasks and exploratory history. The later v2 history run had two green commits and one useful survivor, but the history was not reserved as held out. |
| qs | 07b1d4d82c8f9301c105ea4b94fa2302cfd6e8b4 | Development data. Several operator filters were changed after inspecting these histories; do not count its findings as independent validation. |
| camelcase | 3146708d5ffcd91a8cbc483e4a2585a39545da48 | Development data. Type-test and reassigned-seed filters were tuned against this history; do not count its findings as independent validation. |
| validator.js | 9ff342479591ca5a43cb30000195bcf55c1bbed9 | Held-out operator sample, selected before the three-commit result. The three selected commits produced no alternatives, so the outcome is a generator-coverage miss, not a clean test result. |

## Interpretation notes

- E20/E21 Claude records are infrastructure failures, not completed agent tasks.
- The two bytes task prompts in the gpt-6-sol sample asked for behavior already present at the pinned revision. Do not count them as valid change tasks.
- X05/X06 are the two valid completed gpt-6-sol tasks. Their E25 verification records use full-suite baselines after filtered Jest runs hit the repository-wide coverage threshold.
- E26 repeats the X06 analysis and is not an independent sample.
- The bytes and ms historical summaries disagree across runs. E19/E22 identify the matching later structured records used in the report; contradictory older files remain archived and are excluded from headline performance metrics.
- Feedback transcript redaction replaces only the private ntfy topic. Diffs, test results, model response, and verifier outcomes are preserved.
