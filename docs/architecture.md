# Architecture

trading agent is a local application for research, options analysis, strategy accounting, and human-confirmed paper orders. Its application layer separates the conversation runtime, deterministic business tools, data providers, and execution permissions.

The application supplies the trading services and permission boundaries. The conversation engine is provided by an external SDK; [runtime integration](runtime-integration.md) identifies the dependency and distinguishes reused components from application code.

## Runtime boundaries

```mermaid
flowchart TD
    Web[Web and trading CLI] --> Session[Conversation runtime and model tools]
    Native[Terminal: TUI / print / JSON / RPC] --> NS[Isolated terminal session]
    NS --> Bridge[IPC tool bridge]
    NS --> Resources[Native resources and model authentication]
    Session <--> JSONL[SessionManager JSONL]
    Session --> Gate[Scoped tool registry]
    Bridge --> Gate
    Gate --> Computer[Official file and shell tools]
    Computer --> Sandbox[Workspace sandbox]
    Gate --> Service[TradingService: validation, actor, scopes, audit]
    Web --> Service
    Service --> Quant[Deterministic calculations]
    Service --> Ledger[Strategy ledger]
    Service --> Research[Research and workspace services]
    Service --> Read[Read-only provider adapters]
    Service --> Reconcile[Added: saved position and execution reconciliation]
    Read --> Snapshots[Fixed broker snapshots]
    Snapshots --> Reconcile
    Ledger --> Reconcile
    Reconcile --> DB
    Scheduler[Modified: independent background scheduling] --> Monitor[Added: opt-in order monitor]
    Monitor --> Query[Reused: TradeFlow.refresh / gateway GET]
    Query --> Execution
    Monitor --> Inbox[Modified: scope-filtered local notifications]
    Monitor --> DB
    Service --> Intent[Trade intent and immutable preview]
    Intent --> Review[User confirmation card]
    Review --> Execution[IBKR paper execution adapter]
    Execution -. configured connection .-> IBKR[IBKR paper Gateway]
    Service <--> DB[Business SQLite]
    Ledger <--> LDB[Ledger SQLite]
```

The model can prepare a trade and read its status. Human-only confirmation endpoints are not registered as model tools. A chat response such as “yes” is not an execution capability.

## Modules

| Path | Responsibility |
|---|---|
| `apps/trading-agent/runtime.js` | Construct the standalone application, data directories, ledger, conversation adapter, and service. |
| `apps/trading-agent/server.js` | Authenticated loopback HTTP API and static UI. |
| `apps/trading-agent/web/` | Research views, conversations, ledger forms, and broker confirmation cards. |
| `packages/trading/pi-session-runtime.js` | Official AgentSession integration, events, budgets, cancellation, history, and settings. |
| `packages/trading/pi-native-*.js` | Native settings, isolated CLI launch, and IPC bridge. |
| `packages/trading/computer-*.js` | Official file/Shell tools with separate grants and process isolation. |
| `packages/trading/service.js` | Business dispatch, validation, scope enforcement, and audit. |
| `packages/trading/catalog.js` | Operation contracts, extended catalog, and trade catalog. |
| `packages/trading/quant.js` | Pricing, Greeks, IV, scenarios, Wheel constraints, and portfolio calculations. |
| `packages/trading/providers.js` | Fixed read-only market and brokerage transports. |
| `packages/trading/trade-flow.js` | Intent revisions, preview, confirmation capabilities, and order state. |
| `packages/trading/ibkr-execution.js` | Fixed IBKR paper contract, preview, submission, warning, and query endpoints. |
| `packages/trading/reconciliation.js` | Fixed snapshot comparison, explicit mappings, execution deduplication, historical reports and human review. |
| `packages/trading/order-monitor.js` | Per-order opt-in queries, persisted leases, backoff, status notifications and terminal stop. |
| `packages/trading/storage.js` | Versioned business records and append-only audit events. |
| `packages/ledger/ledger.js` | Integer-cent strategy ledger and reviewed changes. |
| `packages/trading/paper.js` | Separate local simulation account and order book. |

## Data ownership

Runtime JSONL is authoritative for native conversation history. SQLite stores the application's UI projection and business records. Editing a conversation creates a branch; it does not replace the source history.

The strategy ledger stores a per-symbol cost convention. It is not a broker tax-lot database. Broker receipts and snapshots do not silently rewrite it.

Data paths are selected with `--home`. File tools operate in a separate workspace, and the native CLI uses a separate resource directory. Source files and application databases cannot be granted as the computer-tool workspace.

## External services

Provider configuration, model credentials, and execution configuration are separate. Read-only data adapters cannot submit orders. The IBKR paper adapter requires an explicit account allowlist and checks the Gateway's paper-session status.

The repository includes controlled-response tests. External account access, data subscriptions, model behavior, and broker execution must be validated in the configured environment.

See [technical design](technical-design.md), [native capabilities](runtime-capabilities.md), and [conversational trading](conversational-trading.md).

## 3.4 changes

Added report and watch record types in the existing SQLite store; no ledger schema migration. Modified the scheduler, scope filtering and browser views. Reused the runtime, native tools, ledger, provider transport and human execution gate. Automatic ledger posting and complete historical cash-flow reconciliation remain unimplemented. See [design and interfaces](reconciliation-and-monitoring.md).
