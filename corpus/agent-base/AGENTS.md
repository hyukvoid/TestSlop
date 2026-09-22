# order-service

Internal order management service. TypeScript, ESM, Node 20+.

## Running the tests

```bash
npx vitest run
```

A single file:

```bash
npx vitest run src/pricing.test.ts
```

The suite should be green before you finish. Do not commit; leave your changes in
the working tree.

## Conventions

- Money is integer cents everywhere. Never use floats for currency.
- Relative imports include the `.ts` extension.
- Domain failures throw the error types in `src/errors.ts`, never plain strings.
- Tests live next to the code as `*.test.ts`.
- Keep functions exported if they are worth testing directly.

## Module map

| File | Responsibility |
| --- | --- |
| `src/money.ts` | integer-cent arithmetic, formatting |
| `src/pricing.ts` | line totals, volume discounts, tax rates |
| `src/inventory.ts` | stock levels, reservations, commit/release |
| `src/orders.ts` | order status state machine |
| `src/pagination.ts` | offset paging, Link header |
| `src/idempotency.ts` | request de-duplication cache |
| `src/retry.ts` | retry with exponential backoff and jitter |
| `src/webhooks.ts` | HMAC payload signing and verification |
| `src/address.ts` | postal address normalisation and validation |
| `src/errors.ts` | domain error types |
