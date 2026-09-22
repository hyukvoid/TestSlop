# agent-base

A small but realistic order-management service, used as the working repository for
the POC-01 independent-agent benchmark.

It is ordinary domain code: pricing, inventory reservation, discount rules, an
idempotency cache, pagination, a retry helper, webhook signing, and address
validation. It was written as a plausible service, **not** as bait for any
TestSlop detector, and it exists in the tree before any task prompt was written.

The existing test suite is deliberately *decent but incomplete* — the state a real
codebase is usually in when someone asks an agent to change it. Some modules are
well covered, some have only happy-path tests, and a few have none.

## Provenance and bias

This codebase was written by the author of TestSlop. That is a real limitation and
is stated in the POC-01 report. What matters for the benchmark is that the
**agent's diff** is independent, which it is: the agent receives a task
description, works unsupervised, and its output is captured verbatim.

To check that the authored base is not producing an artefact, a subset of tasks is
also run against real open-source repositories. See `corpus/agent-tasks/`.

## Layout

```
src/pricing.ts        line totals, tiered discounts, tax
src/inventory.ts      stock reservation and release
src/orders.ts         order state machine
src/pagination.ts     offset/limit paging with metadata
src/idempotency.ts    request de-duplication cache with TTL
src/retry.ts          retry with backoff and jitter
src/webhooks.ts       HMAC signature generation and verification
src/address.ts        postal address normalisation and validation
src/money.ts          integer-cent money arithmetic
src/errors.ts         domain error types
```
