# Pi Trading Agent

[简体中文](README.md) · [Architecture](docs/architecture.md) · [API catalog](docs/api-catalog.md)

A local options research and paper-trading workbench built on [Pi Coding Agent](https://github.com/earendil-works/pi). It combines deterministic options calculations, a strategy ledger, market research, and human-confirmed IBKR paper orders.

The model collects requirements, calls tools, and explains results. Code calculates Greeks and enforces strategy constraints. Only the authenticated user can confirm a broker action.

## Features

- Black–Scholes and CRR pricing, implied volatility, Greeks, scenarios, and covered-call / cash-secured-put checks.
- A SQLite strategy ledger with integer-cent accounting and per-symbol option cash flows.
- Financial research, technical indicators, portfolio backtests, prediction-market comparisons, reports, and local alerts.
- Conversational order preparation: missing-field questions, contract lookup, what-if preview, human review, broker warning handling, and status reconciliation.
- Pi's original file and shell tools, resource discovery, compaction, retry, session trees, and an isolated native CLI for TUI, RPC, extensions, and MCP.

## Run locally

The full application is tested on **macOS with Node.js 26**. File, shell, and native-CLI isolation currently require macOS `sandbox-exec`.

```sh
git clone https://github.com/Leon1689/pi-trading-agent.git
cd pi-trading-agent
npm ci --ignore-scripts
node apps/pi-trader/cli.js init --home "$HOME/.local/share/pi-trader"
npm start -- --home "$HOME/.local/share/pi-trader" --port 3100
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

`apps/pi-trader` hosts the standalone app. `packages/trading` contains domain tools and Pi adapters; `packages/ledger` owns the ledger. `packages/preset` retains legacy Harness compatibility and is not required by the main application. Documentation, credential-free examples, and CI live in `docs`, `examples`, and `.github`.

```sh
npm run check
npm test
node examples/option-pricing.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [verification notes](docs/verification.md).

## License

[MIT](LICENSE). Upstream attribution is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This is an independent project, not an official Pi, IBKR, or RockFlow product.
