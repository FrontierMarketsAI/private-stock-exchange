# Contributing

Contribute improvements to `@frontier-markets/privacy-sdk`, its examples, tests,
and documentation. Use Node.js 24 and preserve the package's ESM interface.

## Local Checks

Use Node.js 24. From a clean checkout:

```sh
npm ci --ignore-scripts
npm run check
npm pack
```

`npm run check` runs type checking, the build, tests, and package validation.
Tests use injected transports and synthetic fixtures and run offline without
credentials or live services. Dependency installation may require network access.
The CLI examples make live requests; use the test suite for offline verification.

## Change Expectations

- Preserve the package-root SDK interface in `src/client/index.ts` and ESM import conventions.
- Add focused offline regression coverage for changed behavior, including strict validation, exact reviewed-quote binding, local ciphertext/calldata, and nonce-gated status handling where relevant.
- Preserve sanitized errors, bounded responses/timeouts, redirect rejection, and explicit caller control of approval, signing, broadcasting, retrying, and polling.
- Use synthetic keys and orders in fixtures. Never submit credentials, private bundles, real nonces, sensitive RPC URLs, or identifying deposit-to-payout data.
- Describe behavior changes and verification results in your contribution. Update the relevant API, SDK, or example documentation alongside code changes.

## API Snapshot

`docs/openapi.json` is the checked-in public API specification. To refresh it:

```sh
npm run docs:update
```

This command fetches the live public specification without credentials.
Review the diff for public-only content, accurate
endpoint/auth/status semantics, and current package references. Align shared
schemas, SDK behavior, tests, and documentation in the same change, then run the
local checks.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in
a public issue or contribution containing sensitive reproduction data.
