# trading agent

[简体中文](README.md) · [Architecture](docs/architecture.md) · [API catalog](docs/api-catalog.md)

An independent trading research application designed and maintained by Leon1689. It combines deterministic options calculations, a strategy ledger, market research, and human-confirmed IBKR paper orders.

The model collects requirements, calls tools, and explains results. Code calculates Greeks and enforces strategy constraints. Only the authenticated user can confirm a broker action.

## Features

- Black–Scholes and CRR pricing, implied volatility, Greeks, scenarios, and covered-call / cash-secured-put checks.
- A SQLite strategy ledger with integer-cent accounting and per-symbol option cash flows.
- Financial research, technical indicators, portfolio backtests, prediction-market comparisons, reports, and local alerts.
- Conversational order preparation: missing-field questions, contract lookup, what-if preview, human review, broker warning handling, and status reconciliation.
- File and shell tools, resource discovery, compaction, retry, session trees, and an isolated native CLI for TUI, RPC, extensions, and MCP.

## Run locally

The full application is tested on **macOS with Node.js 26**. File, shell, and native-CLI isolation currently require macOS `sandbox-exec`.

For native `grep` / `find` and the full test suite, install the search executables with `brew install ripgrep fd`. Sandboxed tools cannot download dependencies. The default four file/Shell tools do not need these executables.

```sh
git clone https://github.com/Leon1689/trading-agent.git
cd trading-agent
npm ci --ignore-scripts
node apps/trading-agent/cli.js init --home "$HOME/.local/share/trading-agent"
npm start -- --home "$HOME/.local/share/trading-agent" --port 3100
```

Open the local authentication URL printed by the server. The default configuration leaves models and data providers disabled; local calculations and the ledger remain available.

Configure `config.json` in the selected data directory. Store credentials in environment variables; `.env.example` lists names, and the application does not automatically load `.env` files.

## Execution modes

| Mode | Behavior |
|---|---|
| `READ_ONLY` | Research and broker queries; no broker order submission. |
| `LOCAL_PAPER` | Local order book with explicit manual simulation fills. |
| `IBKR_PAPER` | Allowlisted DU accounts; separate human confirmation for orders and each broker warning. |

The release contains the IBKR paper protocol adapter, verified against controlled responses. Live model and brokerage connections require configuration and independent acceptance checks. Funded-account execution, FX, copy trading, and multi-leg execution are not implemented.

## Project layout

`apps/trading-agent` hosts the standalone app. `packages/trading` contains domain tools and runtime adapters; `packages/ledger` owns the ledger. `packages/preset` retains legacy Harness compatibility and is not required by the main application. Documentation, credential-free examples, and CI live in `docs`, `examples`, and `.github`.

The application implements the trade-intent state machine, human-confirmation workflow, scoped service catalog, deterministic calculations, strategy ledger, and provider adapters. The external runtime supplies the generic agent loop, native tools, and terminal capabilities. See [implementation](docs/implementation.md) and [runtime integration](docs/runtime-integration.md) for the boundaries and code references.

```sh
npm run check
npm test
node examples/option-pricing.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [verification notes](docs/verification.md).

## License

[MIT](LICENSE). Upstream attribution is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Reconciliation and monitoring

Version 3.4 adds saved position/execution comparisons with explicit account and contract mappings, plus per-order opt-in background status queries. Reports do not post to the ledger; monitoring never submits or replays an order. See [usage, contracts and limits](docs/reconciliation-and-monitoring.md). Run `node examples/reconciliation.mjs` for an offline synthetic example.

## Personal assistant (3.5)

Investment plans with human acceptance, holdings briefings, same-expiry multi-leg option payoff and Greeks, public prediction order books, persistent research/condition jobs, and opt-in browser notifications. See [design and limitations](docs/personal-assistant.md) and [coverage](docs/bobby-coverage.md). Run `node examples/personal-assistant.mjs` without credentials.
