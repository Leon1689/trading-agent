# Workbench guide

## Local setup

Use Node.js 26 on macOS. Run `npm ci --ignore-scripts`, initialize a data directory, then start the application:

```sh
node apps/trading-agent/cli.js init --home "$HOME/.local/share/trading-agent"
npm start -- --home "$HOME/.local/share/trading-agent" --port 3100
```

The server prints a local authentication link. Configuration is loaded from that data directory's `config.json`; restart after changing it. Initialization will not overwrite an existing file.

## Calculations and ledger

The options page accepts explicit pricing and risk inputs without a model. Review units, contract multipliers, date conventions, and missing data before using a result.

The ledger page stores holdings, confirmed premiums, and assignment events. Revisions prevent stale changes from overwriting newer state. Proposed model changes require review; a broker snapshot is not imported as confirmed strategy history automatically.

## Conversations

Configure the model provider, model ID, and credential environment-variable name. Grant only the scopes needed for the question. File/Shell permissions, imported files, resources, account data, and trade preparation are separate choices.

Private data already in a conversation remains in its history. To continue, restore its required scopes or create a new empty conversation. Editing a message creates a branch.

## Orders

Local paper orders and IBKR paper orders are distinct. For IBKR, enable the independent execution configuration, log into the paper Gateway, select the configured account, and follow the [conversation workflow](conversational-trading.md).

A complete request specifies the account, instrument, direction, position effect, quantity, limit, currency, duration, and trading session. Options also require expiry, right, strike, multiplier, and the verified contract ID. Incomplete requests stay as drafts.

Review the confirmation card and broker warnings before clicking the final button. Submitted is not Filled. Query the broker status before interpreting a receipt as a fill. If a network result is unknown, do not create a duplicate order.

## Terminal entry

```sh
npm run native -- --home "$HOME/.local/share/trading-agent" --scopes compute,resources --
npm run native -- --home "$HOME/.local/share/trading-agent" --scopes compute,resources -- --mode rpc
```

Add localRead/localWrite/shell only when needed. Native file paths and network destinations are controlled by configuration. See [native capabilities](runtime-capabilities.md).

## Data and compatibility

Keep runtime data outside the source checkout and back it up before migration. The default standalone application does not use Harness. The legacy packages remain available for existing installations; see [migration](upgrade-3.0.md).
