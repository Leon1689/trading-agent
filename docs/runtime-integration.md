# Runtime integration

The conversation runtime is an external dependency: Pi Coding Agent 1.6.0. The application integrates it with trading services, persistence, and permission boundaries. Dependency versions and attribution are recorded in [third-party notices](../THIRD_PARTY_NOTICES.md).

```mermaid
flowchart LR
    UI[Runtime CLI / TUI / RPC] --> Session[AgentSession]
    Session --> Core[Agent core and model runtime]
    Session --> Tools[Native tools]
    Session --> Resources[Resources / extensions / MCP]
    Session <--> History[SessionManager JSONL tree]
```

The runtime components remain available through the terminal entry. The trading Web application uses the same SDK with a scoped tool registry and application-specific persistence. The complete application diagram is in [architecture](architecture.md).

| Component | Runtime dependency | Trading application | Relationship |
|---|---|---|---|
| Agent loop and model calls | AgentSession, core, ModelRuntime | Same official implementations | Reused |
| History and branching | SessionManager JSONL | Native history plus SQLite UI projection | Reused; application projection added |
| read/bash/edit/write | Official tools | Official tools behind independent grants | Reused; authorization added |
| Resource discovery | Context files, skills, prompts | Configurable discovery with resource grants | Reused; loading boundary adjusted |
| Compaction and retry | Native settings | Same settings and SDK behavior | Reused |
| TUI, RPC, MCP, extensions | Native CLI | Isolated official CLI with IPC domain tools | Reused; process boundary added |
| Models and credentials | Native authentication and configuration | Separate native resource directory and explicit Web provider settings | Configuration adjusted |
| Trading calculations | Extension responsibility | Greeks, IV, risk, Wheel, backtests | Added |
| Strategy ledger | Application responsibility | Versioned integer-cent SQLite ledger | Added |
| Market and account data | Extension responsibility | Fixed read-only provider adapters | Added |
| Order preparation | Application responsibility | Structured intent and IBKR what-if | Added |
| Broker actions | Application responsibility | Human-confirmed paper-account adapter | Added; external validation required |
| Account reconciliation | Application responsibility | Saved snapshot comparisons and explicit contract mappings; no automatic ledger posting | Added in 3.4 |
| Order monitoring | Application responsibility | Per-order GET polling, leases, backoff and scoped notifications | Added in 3.4 |
| Funded-account trading and commercial services | Outside the runtime scope | No live execution, FX, copy trading, or commercial account integration | Not implemented |

The Web UI does not reproduce every native terminal interaction. Native extensions run through the isolated CLI, and their remote services require configuration. Retaining a native command is distinct from testing every provider, device, or remote integration.
