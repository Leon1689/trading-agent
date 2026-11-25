# Examples

`node examples/option-pricing.mjs` calculates a European call using synthetic inputs. It does not make network requests.

Start a local configuration with the root `config.example.json`. For broker paper execution, merge the `execution` section from `config.ibkr-paper.example.json` into your data directory's configuration after replacing the account placeholder. Do not copy it over an existing file without preserving your settings.

Model keys and market-data credentials belong in environment variables. See [provider setup](../docs/provider-setup.md).
