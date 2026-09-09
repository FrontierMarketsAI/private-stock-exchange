# Security Policy

## Report Privately

Private vulnerability reporting is enabled. Report vulnerabilities through a
[GitHub private security advisory](https://github.com/FrontierMarketsAI/private-stock-exchange/security/advisories/new).
Do not open a public issue containing an exploit, API key, wallet key, private
intent, status nonce, order bundle, or deposit-to-payout relationship.

Include the affected SDK version or commit, impact, and a minimal reproduction
using synthetic data. Redact credentials, identifying order data, private paths,
and provider URLs containing tokens. Coordinate disclosure privately with the
maintainers. For exposed API credentials, request revocation/rotation from a
Frontier administrator immediately; deleting a public post is not revocation.

## Secure Integration

- Keep API credentials in your server's secret manager and wallet private keys in your signing environment.
- Independently verify and, where possible, pin the vault and encryption public key. A compromised configuration source can undermine encryption and transaction destination checks without independent pins.
- Treat custom `fetch` implementations as trusted code. They must honor redirect rejection and must not forward credentials to another origin. Use HTTPS; insecure HTTP is an explicit loopback-only development option.
- Review the exact quote, recipient, chain, amounts, and unsigned transaction. Simulate before external signing and broadcast. For sells, verify allowance and separately approve only the required amount to the verified vault.
- Persist private order bundles before funding, outside checkouts and web roots. Use owner-only `0700` directories and `0600` files. Exclude bundles, nonces, credentials, and deposit-to-payout links from logs, telemetry, screenshots, issues, and shared artifacts.
- Preserve the original bundle and actual deposit hash after any uncertain wallet or status response. `confirming`, timeouts, and HTTP failures do not prove funding failed. Never automatically fund a replacement.

The SDK encrypts instructions locally and prepares unsigned transactions. Your
application handles approvals, simulation, signing, submission, retries, and polling.
Check balances, allowances, and current liquidity before funding.
When using lower-level builders, perform the fresh configuration and reviewed-quote
checks provided by `prepareTrade` yourself.

## Privacy And Trust

Frontier combines client-side intent encryption, fresh single-use payout
addresses, and batched execution. Trading relies on Frontier's execution service
until payout completes.

`recipient` defaults to `sender`. Use a separate receiving wallet by setting
`recipient` in `prepareTrade`, and avoid publishing transaction relationships.
Review wallet and RPC-provider privacy settings and disable
sensitive request/response logging in application monitoring.

The API key controls HTTP admission; the private per-order nonce is a separate
status capability. Anyone with the required credential and nonce may obtain
private status details. Protect both, and do not expose status responses in public
logs even though the SDK sanitizes errors.

See [status and recovery](README.md#status-and-recovery) for confirmation
semantics and handling unresolved orders.
