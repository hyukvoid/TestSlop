# Historical replay: `ms` year boundary

TestSlop found this boundary in upstream [`ms`](https://github.com/vercel/ms) commit [`3ba274e015722cbe1cdaa40f14f8c2954d8df0f3`](https://github.com/vercel/ms/commit/3ba274e015722cbe1cdaa40f14f8c2954d8df0f3), “add support for months”. The parent is `0d5ab182ef22686cb4086fe9b67b1276bcb644ef`.

## Replay metadata

- Repository: `vercel/ms`
- Commit under review: `3ba274e015722cbe1cdaa40f14f8c2954d8df0f3`
- Base revision: parent `0d5ab182ef22686cb4086fe9b67b1276bcb644ef`
- Test command: `npx vitest run --reporter=dot` with the root lockfile's Vitest `3.2.4`
- Commit change: add year and month branches to short/long formatting, with the year boundary `msAbs >= y`
- Evil Twin: change the short formatter's boundary to `msAbs > y`
- Result: both implementations pass `163 / 163` tests
- Missing witness: `ms = 31,557,600,000 ms`; short output changes from `1y` to `12mo`

At exactly one year the original branch reports a year. The Twin skips that branch and rounds the month output to `12mo`. The commit's formatter tests checked one millisecond above the year threshold, but not exactly at it.

The `parent/` and `month-support/` folders preserve the upstream `src/index.ts` and all four `src/*test.ts` files from those revisions. The replay script builds a disposable Git repository from those snapshots, then changes only the import of Jest's `describe`/`it`/`expect` to Vitest in the disposable copy. Assertions and production source remain unchanged. It uses this project's locked Vitest dependency, makes no network call, and removes its temporary repository and scratch copies on exit.

Run it with:

```bash
npm run demo:history
```

This is one focused historical example, not evidence that TestSlop reliably finds shipped bugs. The complete upstream repository and its original Jest runner are not bundled.