# Technical design

Application 3.3.0 separates business operations, calculation, storage, runtime integration, and broker execution. The primary entry is the standalone application; legacy adapters are optional compatibility components.

## Operation contract

`TradingService.execute(operation, args, context)` resolves the operation descriptor, checks the bound caller and scopes, validates the schema, dispatches the handler, and records input/result hashes or a safe error code.

Each catalog entry contains `operation`, `title`, `description`, `group`, `kind`, `scope`, `model`, `inputSchema`, and `example`. Unknown fields are rejected where the contract requires a closed object. Runtime handlers perform semantic validation in addition to schema checks.

The catalog contains 101 operations. Only the 57 entries marked for model use can become tools, and the current scope further restricts them. The remaining 44 operations are human-only. Built-in runtime tools are managed separately.

- HTTP handlers bind the caller as human after local authentication and request checks.
- Runtime tool adapters bind the caller as model and supply the granted scopes.
- Neither `actor` nor extra authority can be supplied through tool JSON.
- `trade.review`, `trade.confirm`, and other human actions are never exposed as model tools.

Full schemas are in [api-catalog.json](api-catalog.json).

## Permissions

| Scope | Grants |
|---|---|
| `market`, `compute`, `predict` | Public-data research and deterministic calculations. |
| `broker` | Configured read-only account data. |
| `trade` | Trade intent, contract lookup, what-if preparation, and order-status queries. |
| `ledger`, `portfolio`, `files` | Strategy ledger, saved research, and imported files. |
| `localRead`, `localWrite`, `shell` | Separate computer-tool permissions. |
| `resources` | Native project context, skills, and templates. |

Private scopes used in conversation history are remembered. Continuing that history requires the relevant scopes again; removing a checkbox does not erase private material already present in the transcript.

Web computer tools run in sandboxed workers without network access or inherited application credentials. The native CLI has its own path, network, process, and callback grants. Broker destinations cannot be added to its outbound network allowlist.

## Persistence

`TradingStore` stores versioned records with `(kind, id)` keys, revision numbers, JSON bodies, and timestamps. An expected revision of zero creates exclusively; updates require the revision that was read. Local transactions never wait for network calls. Audit events are append-only.

Record families include chat projections, files, reports, portfolios, watchlists, notifications, alerts, provider snapshots, local paper accounts/orders, conditional previews, and trade intents.

The SDK’s `SessionManager` owns the JSONL tree. The application records native user entry IDs for branch operations and exports the original JSONL. Interrupted runs retain their status and can be recovered explicitly without replaying the previous request.

## Models and native capabilities

The runtime dependency is `@earendil-works/pi-coding-agent@1.6.0`. See [runtime integration](runtime-integration.md) for the application/dependency split and [third-party notices](../THIRD_PARTY_NOTICES.md) for attribution.

`createPiSessionRunner` constructs official `AgentSession`, `ModelRuntime`, and `SessionManager` instances. The SDK owns the tool loop, streaming, retry, and compaction. Configuration supplies provider/model references, token and call budgets, timeout, native settings, and resource paths.

The default four computer tools use the dependency’s implementations. Optional grep/find/ls/powershell retain their original factories. The native CLI provides terminal UI, RPC, extensions, MCP, package commands, authentication, themes, and other native functions through its isolated entry.

See [runtime capabilities](runtime-capabilities.md) for the settings and entry-point boundaries.

## Calculations and ledger

Pricing, Greeks, implied volatility, scenarios, backtests, and Wheel checks are pure calculations over explicit inputs. Results carry calculation identifiers, versions, hashes, units, and input authority. They do not infer broker reconciliation from a model's claim.

The ledger uses integer cents for monetary accounting. For a held symbol, personal cost is `C = (N - P) / Q`, where `N` is nominal cost, `P` confirmed option cash flow for that symbol, and `Q` shares. Covered-call strike must be strictly greater than `C`; proposed premium does not reduce cost in advance.

Missing coverage, uncertain deliverables, unconfirmed cash, or incomplete risk checks cannot silently produce an executable approval. An analysis result is not an order authorization.

## Execution

- `READ_ONLY`: calculations and queries; no broker order writes.
- `LOCAL_PAPER`: independent local order book with explicit simulated fills.
- `IBKR_PAPER`: allowlisted DU accounts, a paper Gateway session, and human confirmation.

Trade intents preserve source messages, fields, missing items, revisions, frozen previews, client order IDs, receipts, and state. The preview is bound to a short-lived human capability. Updates invalidate old confirmation. Submission state is persisted before a network write, and unknown outcomes require reconciliation rather than automatic replay.

Short option openings require human-reconciled Wheel evidence matched to the precise order. Current holdings and visible pending orders are checked before initial submission. Multi-endpoint account reads are not atomic; another client can still change the account.

See [conversational trading](conversational-trading.md) for state transitions, endpoints, and supported order types.

## Network and HTTP boundaries

The server binds to loopback, checks the host and origin, uses an HttpOnly SameSite session cookie, and requires the application request header for mutations. Static caching excludes account data and API responses. Local share snapshots are explicit and expire; they are not public hosting.

Provider transports use fixed endpoints, credential references, timeouts, response-size bounds, pagination limits, and safe error messages. Configuration is loaded at startup and cannot be replaced by model input. TLS validation remains enabled.

## Validation

`npm test` covers public contracts with isolated data directories, actual SDK/CLI execution, and synthetic model/provider responses. `npm run check` validates JavaScript and manifests. See [verification](verification.md) for the distinction between local protocol tests and external acceptance.
