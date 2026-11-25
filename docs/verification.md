# Verification

The full suite requires `rg` and `fd` (`brew install ripgrep fd`). CI installs both before exercising the optional native search tools; workers stay offline during execution.

## Reproduce

On macOS with Node.js 26:

```sh
npm ci --ignore-scripts
npm run check
node scripts/check-publication.mjs
npm test
node examples/option-pricing.mjs
node examples/reconciliation.mjs
```

The suite contains 258 tests. The public repository's CI runs the same commands on a clean macOS runner without model or brokerage secrets.

## Coverage

- Pricing, Greeks, implied volatility, scenario units, Wheel constraints, and portfolio calculations.
- Ledger revisions, integer-cent accounting, confirmed cash flows, assignment, rollback, and proposal review.
- Actual runtime SDK/CLI integration, tool loops, JSONL history, branching, resources, compaction, retry, RPC, and a local MCP fixture.
- File/Shell isolation, separate scopes, resource-history grants, network allowlists, cancellation, and budgets.
- Provider schemas, fixed endpoints, credential redaction, pagination, stale data, and response limits.
- Intent completion, revisions, immutable previews, human confirmation, paper-account checks, warning loops, ambiguous writes, reconciliation, and order-state distinctions.
- Snapshot/ledger mappings, execution deduplication, partial coverage, stale reviews, multi-scope report reads, monitor leases, backoff, pause races and scoped notifications.
- Browser component behavior through an isolated DOM harness.

## Evidence limits

Model responses and brokerage transports are controlled test fixtures. Executing the real runtime SDK with a synthetic model stream verifies integration behavior; it does not validate a live model's reasoning or a brokerage connection.

Real account access, market-data entitlements, Gateway authentication, contract handling, and paper execution need environment-specific acceptance checks. The test suite must never use funded accounts or submit external orders. Local paper fills are not evidence of broker execution.

The macOS isolation backend is required for the complete suite. Other operating systems do not silently fall back to unrestricted file or Shell access.

Version 3.4 browser acceptance uses a separate temporary data directory and an injected synthetic gateway. Report generation/review/export and background terminal status updates are checked without connecting to IBKR.

## 3.5 personal assistant verification (2026-11-25)

- Final full local suite: 279 tests passed, including the missing/duplicate-currency cash regression. The preceding 39 targeted service, client, DOM, HTTP asset and notification tests also passed.
- Deterministic checks cover vertical spreads, naked/covered calls, short/protective puts, straddles and condors, zero-profit intervals, Greek signs/scaling, missing IV and mixed-expiry rejection.
- Service tests cover multi-turn plans, missing questions, human-only acceptance, constraint conflicts, persistence scopes, unknown holdings values, scoped briefs, worker leases, stale quotes, pause during query and no duplicate order drafts.
- Injected GET transport tests validate canonical Polymarket token/market identity and Kalshi fixed-point bid/complement-ask books. They do not prove live connectivity or market-data entitlements.
- The browser verified payoff rendering, checkbox-gated research-plan acceptance and refresh, explicit synthetic prediction-board labels, and a 390 px layout without document overflow. It found missing static asset routes and a narrow-screen navigation overflow; both were fixed. The HTTP suite now traverses every imported browser module.
- Browser notification permission/delivery was tested with an injected Notification class. No OS permission was granted automatically and no cloud delivery was claimed.
- No real model or brokerage credentials were used. No external order was sent. Existing runtime and ledger regression checks remain in the full suite.
