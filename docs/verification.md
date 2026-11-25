# Verification

## Reproduce

On macOS with Node.js 26:

```sh
npm ci --ignore-scripts
npm run check
node scripts/check-publication.mjs
npm test
node examples/option-pricing.mjs
```

The suite contains 236 tests. The public repository's CI runs the same commands on a clean macOS runner without model or brokerage secrets.

## Coverage

- Pricing, Greeks, implied volatility, scenario units, Wheel constraints, and portfolio calculations.
- Ledger revisions, integer-cent accounting, confirmed cash flows, assignment, rollback, and proposal review.
- Actual Pi SDK/CLI integration, tool loops, JSONL history, branching, resources, compaction, retry, RPC, and a local MCP fixture.
- File/Shell isolation, separate scopes, resource-history grants, network allowlists, cancellation, and budgets.
- Provider schemas, fixed endpoints, credential redaction, pagination, stale data, and response limits.
- Intent completion, revisions, immutable previews, human confirmation, paper-account checks, warning loops, ambiguous writes, reconciliation, and order-state distinctions.
- Browser component behavior through an isolated DOM harness.

## Evidence limits

Model responses and brokerage transports are controlled test fixtures. Executing the real Pi SDK with a synthetic model stream verifies integration behavior; it does not validate a live model's reasoning or a brokerage connection.

Real account access, market-data entitlements, Gateway authentication, contract handling, and paper execution need environment-specific acceptance checks. The test suite must never use funded accounts or submit external orders. Local paper fills are not evidence of broker execution.

The macOS isolation backend is required for the complete suite. Other operating systems do not silently fall back to unrestricted file or Shell access.
