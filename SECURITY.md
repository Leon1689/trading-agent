# Security

The application binds to loopback and uses an authenticated browser session. It is a local workstation application, not a multi-user hosted service.

## Credentials and storage

Keep runtime data outside the source checkout. Do not commit broker accounts, access tokens, model credentials, session transcripts, databases, or Gateway certificates. Provider configuration stores environment-variable names; the application reads their values at runtime.

Runtime resources and computer tools have independent grants. Native extensions execute as trusted code within their configured process boundary. Only enable extensions, packages, and MCP servers you intend to trust.

## Broker actions

The default mode is `READ_ONLY`. IBKR execution is limited to configured paper accounts and requires separate human confirmation. The model cannot call the review or confirmation endpoints as a tool. Unknown submission results are retained for reconciliation and are not retried automatically.

The broker snapshot is not atomic across endpoints. Other clients may change positions or orders between requests. Treat the project as an experimental local application until your own environment has been validated.

## Reporting a vulnerability

Use the repository's private vulnerability reporting page: https://github.com/Leon1689/trading-agent/security/advisories/new

Do not post credentials, account details, private transcripts, or reproducible trading instructions involving a real account in a public issue. Include the affected version, a synthetic reproduction, and the expected permission boundary.
