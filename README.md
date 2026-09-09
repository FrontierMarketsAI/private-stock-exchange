# Frontier Private Stock Exchange SDK

- Trading app: `https://priv.frontiermarkets.ai`
- API reference: `https://priv.frontiermarkets.ai/docs`
- OpenAPI JSON: `https://priv.frontiermarkets.ai/openapi.json`

[Schema snapshot](docs/openapi.json) | [Security](SECURITY.md) | [Contributing](CONTRIBUTING.md)

Trade on Robinhood Chain with client-side intent encryption, fresh single-use payout addresses, and batched execution through Frontier Markets.

`@frontier-markets/privacy-sdk` is a server-side Node.js 24 ESM package for quotes, local unsigned transaction preparation, and private order status. Your wallet stays in control of approvals, signing, and broadcasting.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Authentication](#authentication)
- [API and SDK methods](#api-and-sdk-methods)
- [Client configuration](#client-configuration)
- [Quotes and amounts](#quotes-and-amounts)
- [Prepare and fund](#prepare-and-fund)
- [Status and recovery](#status-and-recovery)
- [Errors and rate limits](#errors-and-rate-limits)
- [Runnable examples](#runnable-examples)
- [TypeScript interfaces](#typescript-interfaces)
- [Validation and transport](#validation-and-transport)
- [Development](#development)

## Install

Use Node.js 24 and npm:

```sh
npm install github:FrontierMarketsAI/private-stock-exchange
```

Allow the package's `prepare` lifecycle script so npm can build its ESM output during installation.

### Local Build

To work from a clone or build a tarball:

```sh
git clone https://github.com/FrontierMarketsAI/private-stock-exchange.git
cd private-stock-exchange
npm ci --ignore-scripts
npm run check
npm pack
```

Install the resulting tarball in your integration project:

```sh
npm install /absolute/path/to/private-stock-exchange/frontier-markets-privacy-sdk-0.1.0.tgz
```

## Quickstart

Request a Frontier API key and inject it into your server's `FRONTIER_API_KEY` environment variable through your secret manager.

```ts
import { FrontierClient } from '@frontier-markets/privacy-sdk';

const apiKey = process.env.FRONTIER_API_KEY;
if (!apiKey) throw new Error('FRONTIER_API_KEY is required');

const client = new FrontierClient({ apiKey });
const config = await client.getConfig();
const { assets } = await client.getAssets();
const stock = assets.find(
  (asset) => asset.enabled && asset.unavailableReason === null,
);

if (!config.acceptingOrders || config.paused || !stock) {
  throw new Error('Trading is not ready');
}

const request = {
  stock: stock.address,
  side: 'buy' as const,
  amount: '1000000000000000', // 0.001 ETH in raw units.
  slippageBps: 50, // 0.5%.
};

const quote = await client.quote(request);
// Review this exact request and quote before preparing a trade.
```

To continue, use `prepareTrade({ request, quote, sender, recipient })`, persist its private order bundle, and submit the unsigned transaction through your wallet. The complete workflow is in [Prepare and fund](#prepare-and-fund).

## Authentication

Every API endpoint requires:

```http
Authorization: Bearer <id>.<secret>
```

The SDK adds this header from `apiKey`. Keep the key in a server-side secret manager, out of browser bundles, URLs, source, logs, and issues. Wallet keys remain in your signing environment.

Private order status also requires the saved order nonce. An API key grants API access; the nonce grants access to that order's detailed status.

Use the documented API host. Origin restrictions apply to cross-origin callers; the SDK does not send an `Origin` header.

## API and SDK Methods

- API base: `https://priv.frontiermarkets.ai/api/v1`
- Chain: Robinhood Chain, ID `4663`
- Response protocol: `version: 2`

| Method | Endpoint | SDK method | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/config` | `getConfig()` | Read chain, vault, encryption public key, limits, fees, and trading readiness |
| GET | `/api/v1/assets` | `getAssets()` | Discover registered stock tokens and their availability |
| POST | `/api/v1/quote` | `quote(request)` | Get a quote for an exact stock, direction, amount, and slippage |
| POST | `/api/v1/orders/status` | `getOrderStatus({ depositHash, nonce })` | Track a funded order using its private nonce |

Send POST bodies as JSON. `prepareTrade()` runs locally: it encrypts the reviewed intent and constructs an unsigned transaction for your wallet.

The package root exports `FrontierClient`, `FrontierApiError`, public API types, and lower-level transaction builders.

## Client Configuration

```ts
import { FrontierClient } from '@frontier-markets/privacy-sdk';

const client = new FrontierClient({
  apiKey: process.env.FRONTIER_API_KEY!,
  baseUrl: 'https://priv.frontiermarkets.ai',
  timeoutMs: 30_000,
  quoteTimeoutMs: 50_000,
  // Optional independently verified values:
  // expectedVault: '0x...',
  // expectedEncryptionPublicKey: '0x...',
});
```

| Option | Default | Purpose |
| --- | --- | --- |
| `apiKey` | Required | Server-side Frontier API credential |
| `baseUrl` | `https://priv.frontiermarkets.ai` | HTTPS origin only, without `/api/v1`, query strings, fragments, or credentials |
| `expectedVault` | Unset | Pin an independently verified vault address |
| `expectedEncryptionPublicKey` | Unset | Pin an independently verified encryption public key |
| `timeoutMs` | `30000` | Timeout for reads and the complete preparation operation |
| `quoteTimeoutMs` | `50000` | Independent timeout for quotes |
| `maxResponseBytes` | `4194304` | Lower the response-byte ceiling; config, quote, and status also have a fixed 16 KiB cap |
| `fetch` | Global `fetch` | Trusted custom transport implementation |
| `allowInsecureLocalhost` | `false` | Explicitly allow HTTP for loopback development |

Timeout options accept integers from 1 through 300,000 milliseconds. Loopback HTTP supports `localhost`, IPv4 127/8, and IPv6 `::1`. Keep HTTPS for remote integrations.

Every method accepts an optional `AbortSignal`:

```ts
const controller = new AbortController();
const assets = await client.getAssets({ signal: controller.signal });
```

## Quotes and Amounts

```ts
interface TradingQuoteRequest {
  stock: Address;
  side: 'buy' | 'sell';
  amount: string;
  slippageBps: number;
}
```

- Select `stock` by its catalog address. An enabled asset still needs a live quote for your amount.
- `buy` spends native ETH for the selected stock; `sell` spends the stock for native ETH.
- Amounts are raw integer strings. Current assets use 18 decimals: `1000000000000000` represents `0.001` input tokens, not necessarily `0.001` shares. Use the catalog multiplier for share display.
- Inputs must be positive and no greater than `2^127 - 1` or the current `maxAmount`. Signs, exponents, decimal points, and leading zeros are rejected.
- Slippage is 1 through 500 basis points, subject to the current config limit. One basis point is 0.01%; `50` means 0.5%.
- Quotes last at most 60 seconds. Preparation requires more than two seconds remaining and preserves the exact reviewed minimum output.
- Wire `amountOut` and `minAmountOut` values are positive `uint256` decimal strings. The encrypted intent's minimum must fit `uint128`; preparation rejects a larger minimum rather than lowering it.
- Pool fees are already included in `amountOut`. The current service fee is 0%; network gas and pool fees still apply.

A quote includes `vault`, `chainId`, `stock`, `side`, `assetIn`, `assetOut`, `routeId`, `amountIn`, `feeAmount`, `poolFees`, `amountOut`, `minAmountOut`, `slippageBps`, `quotedAt`, and `expiresAt`. Timestamps use Unix seconds. The zero address represents native ETH in asset fields; `routeId` is informational and does not lock the execution route.

Quotes do not reserve liquidity. Quote expiry and the encrypted order's deadline are separate: the order deadline uses current API time plus `orderLifetimeSeconds`.

## Prepare and Fund

1. Fetch configuration and assets. Check readiness and independently verify the vault and encryption public key for your SDK pins.
2. For a sell, check allowance through a trusted RPC. If needed, approve exactly the input amount in your wallet and verify the successful receipt and allowance on chain `4663`.
3. Fetch a fresh quote and present the exact request and quote for review. Refresh the quote if it expired during approval or review.
4. Call `prepareTrade()` with that reviewed quote and the funding wallet address.
5. Privately persist the transaction and intent, including `intent.nonce`, before signing or broadcasting.
6. Review and simulate the transaction, obtain wallet consent, and sign and broadcast through your wallet. Save the actual deposit hash with the same order bundle.
7. Query status with that deposit hash and saved nonce. Keep the original order through uncertain responses instead of creating another deposit.

```ts
const prepared = await client.prepareTrade({
  request,
  quote,
  sender, // Actual funding wallet address.
  recipient, // Optional receiving wallet address.
});

// Persist prepared.transaction and prepared.intent privately before funding.
// Then review, simulate, and submit prepared.transaction through your wallet.
```

Preparation snapshots its inputs, fetches fresh config and assets, validates readiness and the reviewed quote, and encrypts locally. It preserves your minimum and does not silently requote.

### Prepared Result

| Field | Meaning |
| --- | --- |
| `transaction` | Unsigned `{ to, chainId, value: bigint, data }`; calldata contains locally generated ciphertext |
| `intent` | Sensitive plaintext instructions, including the private status `nonce` |
| `allowanceRequirement` | For sells: `{ token, owner, spender, amount: bigint }`; omitted for buys |

Check current balances, allowances, and liquidity separately, then simulate before sending. An allowance requirement describes what is needed; it is not an approval transaction.

`recipient` defaults to `sender`. Specify a separate receiving wallet when appropriate. The fresh single-use `payoutAddress` reported after completion is distinct from this receiving wallet.

The normal batch collection window is 25 seconds, followed by execution and verification. Track progress through order status rather than assuming a fixed completion time.

### Private Order Storage

Store the intent and unsigned transaction before funding. Keep API keys out of the order bundle, and exclude private intents, nonces, and transaction relationships from logs and telemetry.

The supplied file-based examples use an owner-only `0700` directory and `0600` files outside the checkout and web roots. Bigint transaction values are saved as decimal strings in JSON. Use a new filename per genuinely new order; never overwrite the bundle of an uncertain submission.

If saving fails, do not fund. Preserve any partial file and investigate before continuing.

## Status and Recovery

After your wallet submits the deposit:

```ts
const status = await client.getOrderStatus({
  depositHash,
  nonce: prepared.intent.nonce,
});
```

| Status | Meaning and action |
| --- | --- |
| `confirming` | The order is not yet available for verified status. Check the original wallet transaction and preserve the bundle; do not repeat the deposit. |
| `processing` | The order is being processed. Check the same order again later. |
| `attention` | Contact support privately before taking further funding action. Do not submit a replacement deposit. |
| `completed` | Verified payout. Includes `outputAmount`, `payoutAddress`, and `recipient`; omits `settlementHash`. |
| `refunded` | Verified refund. Includes `settlementHash`, `outputAmount`, and `recipient`. |

Authenticated statuses also include expiry and asset fields. `confirming` contains only `status`, `depositHash`, and `message`. A valid HTTP **404 confirming** response is a normal SDK result; it does not distinguish an unknown order from an incorrect nonce. Other HTTP errors throw `FrontierApiError`.

Completed and refunded results reflect verified L2 execution. Integrations requiring Ethereum finality should wait for the chain's additional finality stages.

Keep polling and retries bounded. A timeout, HTTP failure, or uncertain wallet response is a reason to inspect the original transaction, not to generate another deposit or nonce. Preserve the same private bundle and actual deposit hash throughout recovery.

## Errors and Rate Limits

Current limits use fixed 60-second windows:

| Budget | Limit |
| --- | --- |
| All API requests | 240 per key and independently per IP |
| Quotes | 30 per key and independently per IP |
| Status requests | 60 per key and independently per IP |
| Global requests | 1,200 |

Shared network traffic can consume the same IP allowance. Concurrency limits may also reject requests. Respect `Retry-After` and use bounded backoff if requests remain rate-limited. POST bodies are limited to 16 KiB; API query strings are rejected.

```ts
import { FrontierApiError } from '@frontier-markets/privacy-sdk';

try {
  const quote = await client.quote(request);
  // Review the quote before preparation.
} catch (error) {
  if (error instanceof FrontierApiError) {
    console.error({
      code: error.code,
      status: error.status,
      serverCode: error.serverCode,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  } else {
    console.error('Check integration configuration privately.');
  }
}
```

`FrontierApiError` exposes a fixed safe `code` and `message`, optional HTTP `status`, and validated HTTP metadata. Log those safe fields rather than arbitrary exception stacks, request bodies, headers, or private bundles.

Local error codes are `INVALID_OPTIONS`, `INVALID_REQUEST`, `INVALID_RESPONSE`, `BODY_TOO_LARGE`, `REDIRECT`, `TIMEOUT`, `CANCELLED`, `NETWORK_ERROR`, `HTTP_ERROR`, `PIN_MISMATCH`, `QUOTE_MISMATCH`, `QUOTE_EXPIRED`, `NOT_READY`, and `PREPARE_FAILED`.

The `serverCode` allowlist is `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_REQUEST`, `INVALID_JSON`, `INVALID_PATH`, `JSON_REQUIRED`, `BODY_TOO_LARGE`, `NOT_FOUND`, `ORIGIN_REQUIRED`, `RATE_LIMITED`, `SERVER_BUSY`, `UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `ASSET_UNAVAILABLE`, `ASSET_CAPACITY`, `NO_POOL_ROUTE`, `NO_LIQUIDITY`, `QUOTE_SEARCH_INCOMPLETE`, and `QUOTE_BUSY`.

`retryAfterSeconds` accepts numeric integer seconds from 0 through 86,400. Unknown server codes and invalid retry headers are omitted. HTTP dates, signs, fractions, exponents, combined values, and header values longer than ten characters are ignored. The SDK leaves retries and polling to your application.

## Runnable Examples

From a [local build](#local-build), use the examples below with privately injected environment variables. They call the live API and leave signing to your wallet.

| Example | Required environment variables | Optional environment variables |
| --- | --- | --- |
| [api-quote.ts](examples/api-quote.ts) | `FRONTIER_API_KEY`, `STOCK_ADDRESS`, `SIDE`, `AMOUNT_RAW` | `FRONTIER_BASE_URL`, `SLIPPAGE_BPS` |
| [api-prepare.ts](examples/api-prepare.ts) | All quote requirements plus `SENDER`, `EXPECTED_VAULT`, `EXPECTED_ENCRYPTION_PUBLIC_KEY`, `PRIVATE_ORDER_FILE`; `RPC_URL` for sells | `FRONTIER_BASE_URL`, `SLIPPAGE_BPS`, `RECIPIENT` |
| [api-status.ts](examples/api-status.ts) | `FRONTIER_API_KEY`, `PRIVATE_ORDER_FILE`; `DEPOSIT_HASH` unless the bundle contains `depositHash` | `FRONTIER_BASE_URL` |

`SIDE` is `buy` or `sell`; `SLIPPAGE_BPS` defaults to `50`. `FRONTIER_BASE_URL` is an origin, such as `https://priv.frontiermarkets.ai`, not an `/api/v1` URL. Obtain expected vault/key values from an independently trusted source.

### Set Up Private Storage

Use a POSIX system for the file-based examples. Choose an absolute canonical path outside the checkout, current working directory, and web-served directories. The parent must exist, be owned by your user, and have mode `0700`; symlinked parents and unsafe writable ancestors are rejected.

For example, if your home directory is outside the checkout:

```sh
umask 077
mkdir -m 700 "$HOME/frontier-private-orders"
export PRIVATE_ORDER_FILE="$HOME/frontier-private-orders/order-001.json"
```

If the directory already exists, verify its ownership and permissions instead of recreating it. The preparation example creates a new bundle exclusively with mode `0600` and refuses overwrites.

### Run the Examples

With the relevant variables set privately:

```sh
npx --no-install tsx examples/api-quote.ts
npx --no-install tsx examples/api-prepare.ts
# After your wallet broadcasts the saved transaction:
npx --no-install tsx examples/api-status.ts
```

The quote example prints a summary. The preparation example obtains a separate quote and saves it with the unsigned transaction for review before funding. For sells, it first checks chain and allowance through read-only HTTPS RPC with retries disabled, then fetches a fresh quote. It does not send the approval or deposit.

The status example reads the saved nonce, accepts the actual `DEPOSIT_HASH` or saved `depositHash`, rejects conflicting hashes, and prints a limited status summary. Keep the private bundle and deposit-to-payout relationship out of shared output.

## TypeScript Interfaces

```ts
import type { Address, Hex } from 'viem';
import type {
  TradingQuote, TradingConfig, TradingAssetsResponse, TradingOrderStatus,
  TradeIntent, FrontierServerCode, FrontierErrorCode,
} from '@frontier-markets/privacy-sdk';

interface FrontierClientOptions {
  apiKey: string;
  baseUrl?: string;
  allowInsecureLocalhost?: boolean;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  quoteTimeoutMs?: number;
  maxResponseBytes?: number;
  expectedVault?: Address;
  expectedEncryptionPublicKey?: Hex;
}

interface FrontierRequestOptions { signal?: AbortSignal }
interface TradingQuoteRequest {
  stock: Address;
  side: 'buy' | 'sell';
  amount: string;
  slippageBps: number;
}
interface TradingStatusRequest { depositHash: Hex; nonce: Hex }
interface PrepareTradeParams {
  request: TradingQuoteRequest;
  quote: TradingQuote;
  sender: Address;
  recipient?: Address;
}
interface AllowanceRequirement {
  token: Address;
  owner: Address;
  spender: Address;
  amount: bigint;
}
interface DepositTransaction {
  to: Address;
  chainId: number;
  value: bigint;
  data: Hex;
}
interface BuildTradeDepositResult {
  transaction: DepositTransaction;
  intent: TradeIntent;
}
interface PrepareTradeResult extends BuildTradeDepositResult {
  allowanceRequirement?: AllowanceRequirement;
}
interface FrontierHttpFailureMetadata {
  serverCode?: FrontierServerCode;
  retryAfterSeconds?: number;
}
declare class FrontierApiError extends Error {
  readonly code: FrontierErrorCode;
  readonly status?: number;
  readonly serverCode?: FrontierServerCode;
  readonly retryAfterSeconds?: number;
  constructor(code: FrontierErrorCode, status?: number, metadata?: FrontierHttpFailureMetadata);
}
declare class FrontierClient {
  constructor(options: FrontierClientOptions);
  getConfig(options?: FrontierRequestOptions): Promise<TradingConfig>;
  getAssets(options?: FrontierRequestOptions): Promise<TradingAssetsResponse>;
  quote(request: TradingQuoteRequest, options?: FrontierRequestOptions): Promise<TradingQuote>;
  getOrderStatus(request: TradingStatusRequest, options?: FrontierRequestOptions): Promise<TradingOrderStatus>;
  prepareTrade(params: PrepareTradeParams, options?: FrontierRequestOptions): Promise<PrepareTradeResult>;
}
```

Config, asset, quote, and status types are exported from the package root. Status is a discriminated union: use `status` to select the fields available on each result.

Additional exports include `TradingAsset`, `TradeSide`, `ApiErrorResponse`, `FrontierErrorCode`, `FrontierServerCode`, `FrontierHttpFailureMetadata`, `buildTradeDepositTransaction`, `encryptTrade`, `validateTradeIntent`, `BuildTradeDepositParams`, `BuildTradeDepositResult`, `TradeIntent`, `DepositTransaction`, `BuildDepositOptions`, `TRADE_MAX_AMOUNT`, `TRADE_PLAINTEXT_BYTES`, and `TRADE_ENVELOPE_BYTES`.

Lower-level builders use the same randomized V2 sealed-box format. When calling them directly, perform the fresh configuration and reviewed-quote checks provided by `prepareTrade` yourself.

## Validation and Transport

- Requests use strict schemas. Response parsing strips unknown and non-applicable fields, including server-provided calldata.
- Addresses receive checksum/nonzero validation where required. Hashes, canonical integer strings, numeric limits, asset pairs, fees, and quote minima are validated before preparation.
- Preparation copies its inputs before network work, then requires current online, unpaused, accepting configuration, a fresh heartbeat, an enabled asset, matching pins, and a quote bound to the reviewed request. Freshness is checked again after encryption.
- Responses are limited to 16 KiB for config, quote, and status and 4 MiB for assets. Both declared length and decoded streamed bytes are checked. Invalid JSON/UTF-8, unexpected media types or success statuses, and redirects are rejected.
- Timeouts and cancellation cover fetching and reading the body, including injected transports that ignore abort. Treat custom fetch implementations as trusted code and never forward credentials to another origin.
- Each client calibrates its clock from a valid HTTP `Date`. Later responses cannot move it backwards; elapsed time is monotonic. Quote timestamps permit five seconds of forward skew, a maximum 60-second lifetime, and require more than two seconds remaining.
- Errors use safe fixed messages and validated metadata rather than copying upstream request data, raw messages, URLs, bodies, headers, or causes.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Checks cover TypeScript, the build, offline tests, package contents, and OpenAPI validation. Tests cover authenticated transport, response bounds, timeout/cancellation, quote binding, local encryption and calldata, status handling, and safe error metadata without contacting live services.

Refresh the public API specification when needed:

```sh
npm run docs:update
```

Review the resulting specification diff and keep schemas, SDK behavior, examples, and documentation aligned.
