# Roadmap

## External acceptance

- Validate configured model providers, context compression, and failure recovery.
- Reconcile read-only account snapshots against the broker's own interface.
- Validate IBKR paper contract resolution, what-if, confirmation, warning handling, fills, and cancellation with an explicitly selected paper account.

## Account reconciliation

- Reconcile fills, fees, corporate actions, and assignments before proposing ledger changes.
- Add source timestamps, coverage reports, and cross-client conflict detection.
- Preserve unknown outcomes and explicit review; do not infer successful execution from missing data.

## Execution extensions

- Add continuous broker status updates and richer order types only with corresponding state and permission tests.
- Design multi-leg execution and cancellation/replacement as separate workflows.
- Treat funded-account execution as a separate design and acceptance milestone, not a configuration alias for paper mode.

## Platform support

- Add Linux and Windows isolation backends with equivalent boundaries.
- Improve native/Web feature navigation while preserving the configured runtime entry points.

## Personal assistant integration (3.5)

See [personal assistant design](personal-assistant.md) for the complete module graph, data structures, operation scopes, workflow and remaining gaps. The additions reuse the existing runtime, ledger and human-confirmed IBKR paper gateway.
