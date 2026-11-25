# Contributing

Install the native search dependencies with `brew install ripgrep fd` before running the complete test suite. CI provisions them explicitly.

Use Node.js 26 on macOS for the complete test suite. Install dependencies with `npm ci --ignore-scripts`; run `npm run check` and `npm test` before opening a pull request.

## Module boundaries

- Keep the primary runtime on the official Pi `AgentSession` and `SessionManager` APIs.
- Keep calculations deterministic and independent of model output or broker transport.
- Register business operations through the catalog and validate every persistence/network boundary.
- Model tools must never expose human confirmation, order submission, or credential changes.
- Preserve separate grants for broker data, trade preparation, local files, Shell, and resources.
- Keep local simulation, IBKR paper execution, and actual broker evidence distinguishable.

Tests must use isolated data directories and synthetic credentials. Do not connect contributor tests or CI to a brokerage account, external model, or paid data source.

For behavior changes, include a regression that exercises the public contract. Update the relevant configuration, architecture, or API documentation. Avoid committing runtime data, transcripts, local paths, screenshots containing account data, or personal configuration.

Pull requests should describe the problem, resulting behavior, validation, and any remaining limitations. Changes to execution modes or confirmation boundaries need explicit design discussion before implementation.
