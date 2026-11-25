# Reconciliation and order monitoring

Application 3.4 adds saved comparisons and per-order background queries. Both work without a model. The example below uses synthetic data and makes no network requests:

```sh
node examples/reconciliation.mjs
```

## Reconcile a saved snapshot

1. In Research, run `broker.snapshot` for an account allowed by the read-only provider configuration. This saves a fixed snapshot; the reconciliation page never silently fetches a newer one.
2. Open **成交与持仓对账**, select the snapshot and load the ledger.
3. For each stock belonging to that account, enter the verified IBKR conid. The existing strategy ledger is USD-only and has no account binding. Leave other holdings unmapped. Confirm the account and contract mapping.
4. Generate the report. Inspect position differences, execution links, duplicates, missing coverage and order-level quantities. Download the JSON or record a review note.
5. If a source ledger revision or account order revision changes, generate another report. The previous report remains historical evidence. A review note is not a ledger correction or permission to trade.

There is no symbol-only contract matching. A missing position becomes zero only if the saved position list is complete. Duplicate contracts, other currencies, options and unmapped holdings remain unresolved. Position differences use `broker quantity − ledger quantity`. Quantity arithmetic uses scaled integers with eight decimal places; it does not compare broker tax cost to the strategy's `C=(N−P)/Q`.

Executions are grouped by `executionId`. Identical records count once; conflicting records with the same ID are excluded from totals and flagged. Linking requires account, `orderRef` matching the saved client order ID, conid, side and currency. The normalizer now preserves account and order reference; older saved snapshots without those fields remain unlinked. Reacquire a snapshot instead of modifying an old one. Quantity and known commission sums retain decimal strings; missing fees are not inferred. Full option cash-flow accounting, tax lots, settlement, assignment and corporate actions are not reconstructed.

IBKR's trades endpoint exposes the currently selected account and a limited recent window, and the documentation advises requesting it once per session. This implementation uses saved snapshots for reports rather than polling trades as an order tracker. A visible quantity match is not proof of complete account history. See [IBKR trades](https://www.interactivebrokers.com/docs/web-api/v1/endpoints/order-monitoring/trades).

## Track an order

After a human-confirmed submission, open **模拟订单** and choose **启用自动查单** on that order. Drafts cannot be monitored. The worker checks status through the existing paper gateway query path; it never submits, replies to warnings, cancels or replays an order. The account/session checks and endpoint pacing still apply.

```json
{
  "orderMonitoring": {
    "enabled": true,
    "pollMs": 10000,
    "intervalMs": 30000,
    "maxFailures": 5
  }
}
```

These are defaults. Deployment enablement alone does not authorize a query: each order must be enabled by a human, and execution must be configured as `IBKR_PAPER`. Configuration is independent of the alerts/briefs scheduler. `pollMs` is at least 5 seconds; an order interval is 15 seconds to 1 hour. Up to ten due orders are visited sequentially per pass. Effective intervals can be longer because of pacing, queueing and errors. The app must be running; this is not an OS background service.

IBKR limits order-list requests to one per five seconds; the existing gateway transport serializes requests and enforces pacing. Other applications sharing the Gateway can still cause rate limiting. See [IBKR pacing limits](https://www.interactivebrokers.com/docs/web-api/v1/pacing-limitations).

Each poll claims a persisted 120-second lease, with a 45-second request deadline. Another process skips the lease; after a crash it can recover when the lease expires. Pausing or changing the watch invalidates in-flight results before an intent or notification write. State commits use optimistic revisions.

Changed status or quantities produce a local notification. Unchanged observations update the watch's check time without incrementing the trade-intent revision or invalidating a human confirmation. Changed receipts invalidate old confirmation as before. The Web cards refresh every five seconds while visible and idle; an open confirmation card or edited input is retained.

An absent order is `ORDER_NOT_VISIBLE`, not evidence of rejection. Failures use exponential backoff capped at one hour, notify on the first failure and at automatic pause, and pause after five failures by default. Resume is explicit. A confirmed terminal receipt stops the watch; a `Filled` label requires the requested filled quantity and zero remaining quantity, and terminal handling requires a broker snapshot. Cancellation stays pending until a terminal observation. No automatic re-submission occurs.

## Interfaces and records

| Operation | Caller | Input | Result |
|---|---|---|---|
| `reconcile.create` | Human | `snapshotId`, `ledgerRevision`, `accountScopeConfirmed`, `bindings[]` | Saved report |
| `reconcile.list` | Human or scoped model | Empty | Latest 200 report summaries by default |
| `reconcile.get` | Human or scoped model | `id` | Report plus current `stale` flag |
| `reconcile.review` | Human | `id`, `revision`, `note` | Reviewed report, no ledger write |
| `trade.watch` | Human | `id`, watch `revision` (0 to create), `enabled`, optional `intervalMs` | Watch configuration/status |
| `trade.monitorStatus` | Human or trade-scoped model | Optional intent `id` | One watch, or latest 200 watches by default |

Model access to reconciliation requires **all three** scopes: `broker`, `ledger`, `trade`. The catalog's optional `requiredScopes` is enforced at tool registration and dispatch. Trade monitoring notifications are filtered from portfolio-only model reads. Creating reports, recording review and enabling monitoring stay human-only; broker execution authority is unchanged.

`reconciliation` records contain `schemaVersion`, fixed `snapshotId/revision`, `ledgerRevision`, `accountId`, explicit `bindings`, an account-order version digest, source/time/authority, `positions[]`, `executions[]`, `orderFills[]`, limitations and one immutable human review. Report generation inspects all account intents up to an explicit 10,000-record bound, rather than silently using the UI's 200-record list. Prior reports are never posted again into the ledger because reports have no posting path.

`tradeWatch` records contain the intent ID, version, `enabled`, `intervalMs`, `nextRunAt`, `lastCheckedAt`, `failures`, sanitized error, stop reason and receipt fingerprint. Internal `runId/leaseUntil` fields are omitted from API responses. Audit events retain checks; notifications retain state changes. Existing SQLite tables support these new record kinds without a destructive migration. Report lists and watches use the configured list limit.

Snapshot freshness is flagged after five minutes, for an unknown receive time or future receive time. Reports always expose non-atomic and incomplete-history limitations. Neither a `MATCH` row nor `REVIEWED` status sets Wheel's `reconciled` or `confirmed` evidence fields.

## Verification and remaining work

Tests cover exact arithmetic, mappings, coverage gaps, duplicates/conflicts, over-limit UI history, model scopes, human review, lease recovery, delayed-response cancellation, notification privacy, unchanged confirmations, failure backoff and terminal states. Browser tests exercise report creation/review and the monitoring buttons. All broker inputs are synthetic; account integration remains pending configuration.

Next work requires broker acceptance for the actual account's execution fields and lifecycle, then an explicit import/proposal design for assignments, corrections, cash movements and historical executions. Automatic posting, full tax-lot reconciliation, WebSocket streaming, external push and funded-account execution are not implemented.
