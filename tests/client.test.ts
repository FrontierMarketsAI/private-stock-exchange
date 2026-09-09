import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import {
  FrontierApiError, FrontierClient, type FrontierClientOptions, type FrontierErrorCode,
  type FrontierServerCode,
  type TradingAssetsResponse, type TradingConfig, type TradingQuote, type TradingQuoteRequest,
} from '../src/client/index.js';
import {
  apiErrorSchema, tradingAssetsSchema, tradingConfigSchema, tradingOrderStatusSchema,
  tradingQuoteRequestSchema, tradingQuoteSchema, tradingStatusRequestSchema,
} from '../src/shared/trading-api.js';
import { generateEncryptionKeyPair, type EncryptionKeyPair } from '../src/sdk/orders.js';
import { decryptTrade } from '../src/sdk/trading.js';
import { tradingVaultAbi } from '../src/trading/abi.js';

const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const vault = address(100), stock = address(300), sender = address(101), recipient = address(102);
const hash: Hex = `0x${'ab'.repeat(32)}`, otherHash: Hex = `0x${'cd'.repeat(32)}`;
const now = 1_800_000_000;
const maximum = (1n << 127n) - 1n;
const apiKey = 'offline-test-credential';
let keys: EncryptionKeyPair;
before(async () => { keys = await generateEncryptionKeyPair(); });

function config(patch: Partial<TradingConfig> = {}): TradingConfig {
  return { version: 2, chainId: 4663, chainName: 'Robinhood Chain', vault,
    explorerUrl: 'https://robinhoodchain.blockscout.com', encryptionPublicKey: keys.publicKey,
    maxAmount: maximum.toString(), feeBps: 0, minimumBatchSize: 2, batchWindowSeconds: 30,
    orderLifetimeSeconds: 1800, defaultSlippageBps: 50, maxSlippageBps: 500, paused: false, acceptingOrders: true,
    service: { state: 'online', message: 'Online', lastHeartbeatAt: now }, ...patch };
}
function assets(): TradingAssetsResponse {
  return { updatedAt: now, assets: [{ address: stock, symbol: 'TEST', name: 'Test Stock', logoUrl: null,
    decimals: 18, multiplier: '1.25', enabled: true, unavailableReason: null }] };
}
function request(sell = false): TradingQuoteRequest {
  return { stock, side: sell ? 'sell' : 'buy', amount: '1000000000000000001', slippageBps: 50 };
}
function quote(sell = false, patch: Partial<TradingQuote> = {}): TradingQuote {
  return { version: 2, chainId: 4663, vault, stock, side: sell ? 'sell' : 'buy',
    assetIn: sell ? stock : zeroAddress, assetOut: sell ? zeroAddress : stock, routeId: hash,
    amountIn: request().amount, feeAmount: '0', poolFees: [3000, 500], amountOut: '10001', minAmountOut: '9950',
    slippageBps: 50, quotedAt: now, expiresAt: now + 60, ...patch };
}
function json(value: unknown, status = 200, date = now): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', Date: new Date(date * 1000).toUTCString(),
  } });
}
interface Call { url: string; init: RequestInit }
function client(handler: (call: Call) => Response | Promise<Response>, options: Partial<FrontierClientOptions> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = { url: String(input), init: init! }; calls.push(call);
    return handler(call);
  };
  return { sdk: new FrontierClient({ apiKey, fetch, ...options }), calls };
}
function failure(code: FrontierErrorCode, status?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof FrontierApiError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /offline-test-credential|super-secret|https:\/\//);
    return true;
  };
}

test('all shared schemas generate input JSON Schema with string bounds and checksum/bigint descriptions', () => {
  for (const schema of [tradingConfigSchema, tradingAssetsSchema, tradingQuoteRequestSchema,
    tradingQuoteSchema, tradingStatusRequestSchema, tradingOrderStatusSchema, apiErrorSchema]) {
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(schema, { io: 'input' })));
  }
  const schema = z.toJSONSchema(tradingQuoteRequestSchema, { io: 'input' });
  assert.equal(schema.additionalProperties, false);
  const stockSchema = schema.properties!.stock!;
  const amountSchema = schema.properties!.amount!;
  assert.ok(typeof stockSchema === 'object' && typeof amountSchema === 'object');
  assert.equal(stockSchema.minLength, 42);
  assert.equal(stockSchema.maxLength, 42);
  assert.match(stockSchema.description!, /checksum/);
  assert.ok(stockSchema.pattern);
  assert.equal(amountSchema.maxLength, 39);
  assert.match(amountSchema.description!, new RegExp(maximum.toString()));
  assert.ok(amountSchema.pattern);
  const wireQuote = z.toJSONSchema(tradingQuoteSchema, { io: 'input' });
  for (const field of ['amountOut', 'minAmountOut']) {
    const outputSchema = wireQuote.properties![field]!;
    assert.ok(typeof outputSchema === 'object');
    assert.equal(outputSchema.maxLength, 78);
    assert.match(outputSchema.description!, new RegExp(((1n << 256n) - 1n).toString()));
  }
});

test('strict request schemas enforce int127, canonical decimals, slippage and checksum', () => {
  for (const amount of ['1', maximum.toString()]) assert.equal(tradingQuoteRequestSchema.parse({ ...request(), amount }).amount, amount);
  for (const patch of [{ amount: '0' }, { amount: '-1' }, { amount: '01' }, { amount: '1e18' },
    { amount: '1.0' }, { amount: (maximum + 1n).toString() }, { amount: '9'.repeat(10000) },
    { slippageBps: 0 }, { slippageBps: 501 }, { slippageBps: 1.1 }, { stock: zeroAddress },
    { stock: '0x52908400098527886E0F7030069857D2E4169Ee7' }, { privateKey: 'super-secret' }]) {
    assert.equal(tradingQuoteRequestSchema.safeParse({ ...request(), ...patch }).success, false);
  }
  assert.equal(tradingStatusRequestSchema.safeParse({ depositHash: hash, nonce: hash, sender }).success, false);
  assert.equal(tradingStatusRequestSchema.safeParse({ depositHash: hash }).success, false);
  assert.equal(tradingStatusRequestSchema.safeParse({ depositHash: '0x12', nonce: hash }).success, false);
});

test('config/assets GET use mandatory Bearer, default versioned origin, safe fetch options and strip extensions', async () => {
  const { sdk, calls } = client(({ url }) => json(url.endsWith('/config')
    ? { ...config(), privateKey: 'super-secret', service: { ...config().service, secret: true } }
    : { ...assets(), assets: [{ ...assets().assets[0], secret: true }], secret: true }));
  assert.deepEqual(await sdk.getConfig(), config());
  assert.deepEqual(await sdk.getAssets(), assets());
  assert.deepEqual(calls.map((call) => call.url), [
    'https://priv.frontiermarkets.ai/api/v1/config', 'https://priv.frontiermarkets.ai/api/v1/assets',
  ]);
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(headers.get('Authorization'), `Bearer ${apiKey}`);
    assert.equal(headers.get('Origin'), null); assert.equal(headers.get('Content-Type'), null);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer');
  }
  assert.equal(JSON.stringify(sdk), '{}');
});

test('constructor rejects missing credentials, private-key options and non-origin/insecure URLs; explicit loopback only', () => {
  for (const options of [{}, { apiKey: '' }, { apiKey: 'bad\r\nkey' }, { apiKey, privateKey: hash },
    ...['http://example.com', 'http://localhost:3000', 'https://host/api/v1', 'https://user:pass@host',
      'https://host?key=super-secret', 'https://host#fragment', 'https://host?', 'https://host/../',
      'file:///tmp/test', ' https://host', 'https://host\\evil'].map((baseUrl) => ({ apiKey, baseUrl }))]) {
    assert.throws(() => new FrontierClient(options as FrontierClientOptions), failure('INVALID_OPTIONS'));
  }
  for (const baseUrl of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://127.0.0.2', 'http://[::1]:3000']) {
    assert.doesNotThrow(() => new FrontierClient({ apiKey, baseUrl, allowInsecureLocalhost: true }));
  }
  for (const baseUrl of ['http://localhost.evil', 'http://0.0.0.0', 'http://192.168.1.1', 'http://[::]']) {
    assert.throws(() => new FrontierClient({ apiKey, baseUrl, allowInsecureLocalhost: true }), failure('INVALID_OPTIONS'));
  }
});

test('quote POST snapshots and binds request, without fetching config/assets or retrying', async () => {
  const input = request();
  const { sdk, calls } = client(() => { input.amount = '5'; return json({ ...quote(), calldata: 'super-secret' }); });
  assert.deepEqual(await sdk.quote(input), quote());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://priv.frontiermarkets.ai/api/v1/quote');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), request());
  assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), `Bearer ${apiKey}`);
  assert.equal(new Headers(calls[0]!.init.headers).get('Content-Type'), 'application/json');
  assert.equal(new Headers(calls[0]!.init.headers).get('Origin'), null);
  for (const patch of [{ amountIn: '20' }, { stock: address(301), assetOut: address(301) },
    { side: 'sell' as const, assetIn: stock, assetOut: zeroAddress }, { slippageBps: 100 }]) {
    await assert.rejects(client(() => json(quote(false, patch))).sdk.quote(request()), failure('QUOTE_MISMATCH'));
  }
  await assert.rejects(sdk.quote({ ...request(), sender } as TradingQuoteRequest), failure('INVALID_REQUEST'));
  assert.equal(calls.length, 1);
});

test('quote response rejects invalid pair, bounds, fee, minimum, TTL and future/expired clocks', async () => {
  for (const patch of [{ chainId: 1 }, { assetIn: stock }, { feeAmount: request().amount },
    { amountOut: (1n << 256n).toString() }, { minAmountOut: '9949' }, { minAmountOut: '10002' },
    { amountIn: (maximum + 1n).toString() }, { routeId: '0x12' }, { poolFees: [] },
    { poolFees: [1_000_001] }, { expiresAt: now + 61 }, { expiresAt: now }]) {
    await assert.rejects(client(() => json({ ...quote(), ...patch })).sdk.quote(request()), failure('INVALID_RESPONSE'));
  }
  for (const patch of [{ quotedAt: now + 6, expiresAt: now + 66 },
    { quotedAt: now - 60, expiresAt: now }, { expiresAt: now + 2 }]) {
    await assert.rejects(client(() => json(quote(false, patch))).sdk.quote(request()), failure('QUOTE_EXPIRED'));
  }
  assert.equal((await client(() => json(quote(false, { minAmountOut: '10000' }))).sdk.quote(request())).minAmountOut, '10000');
});

test('wire quotes accept uint256 outputs while preparation explicitly rejects minima above uint128', async () => {
  const uint128 = (1n << 128n) - 1n;
  const uint256 = (1n << 256n) - 1n;
  for (const amount of [uint128 + 1n, 1n << 200n, uint256]) {
    const reviewed = quote(false, { amountOut: amount.toString(), minAmountOut: amount.toString() });
    assert.deepEqual(tradingQuoteSchema.parse(reviewed), reviewed);
    const { sdk, calls } = client(({ url }) => json(url.endsWith('/quote') ? reviewed
      : url.endsWith('/config') ? config() : assets()));
    assert.deepEqual(await sdk.quote(request()), reviewed);
    await assert.rejects(sdk.prepareTrade({ request: request(), quote: reviewed, sender }), failure('QUOTE_MISMATCH'));
    assert.equal(reviewed.minAmountOut, amount.toString());
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname).sort(),
      ['/api/v1/assets', '/api/v1/config', '/api/v1/quote']);
  }
  // A wire output above uint128 is still usable when the unchanged reviewed minimum fits.
  const reviewed = quote(false, { amountOut: (uint128 + 1n).toString(), minAmountOut: uint128.toString() });
  const { sdk } = client(({ url }) => json(url.endsWith('/config') ? config() : assets()));
  const prepared = await sdk.prepareTrade({ request: request(), quote: reviewed, sender });
  assert.equal(prepared.intent.minAmountOut, uint128.toString());
  for (const amount of [(uint256 + 1n).toString(), '9'.repeat(79), '9'.repeat(10_000), '1e40', '0']) {
    assert.equal(tradingQuoteSchema.safeParse(quote(false, { amountOut: amount, minAmountOut: amount })).success, false);
  }
  const minimum = uint256 * 9950n / 10_000n;
  assert.equal(tradingQuoteSchema.safeParse(quote(false, { amountOut: uint256.toString(), minAmountOut: minimum.toString() })).success, true);
  assert.equal(tradingQuoteSchema.safeParse(quote(false, { amountOut: uint256.toString(), minAmountOut: (minimum - 1n).toString() })).success, false);
});

test('status is the actual V2 union, stripping non-applicable fields rather than exposing them', () => {
  const base = { depositHash: hash, message: 'Status', expiresAt: now + 1800, assetIn: zeroAddress, assetOut: stock };
  assert.deepEqual(tradingOrderStatusSchema.parse({ ...base, status: 'confirming', nonce: hash }),
    { status: 'confirming', depositHash: hash, message: 'Status' });
  for (const status of ['processing', 'attention']) {
    assert.deepEqual(tradingOrderStatusSchema.parse({ ...base, status, recipient, outputAmount: '1' }), { ...base, status });
    assert.equal(tradingOrderStatusSchema.safeParse({ depositHash: hash, status, message: 'Status' }).success, false);
  }
  const completed = { ...base, status: 'completed', outputAmount: '123', recipient, payoutAddress: address(500) };
  assert.deepEqual(tradingOrderStatusSchema.parse({ ...completed, settlementHash: hash }), completed);
  assert.equal(tradingOrderStatusSchema.safeParse({ ...completed, payoutAddress: undefined }).success, false);
  const refunded = { ...base, status: 'refunded', assetOut: zeroAddress, outputAmount: '123', recipient, settlementHash: hash };
  assert.deepEqual(tradingOrderStatusSchema.parse(refunded), refunded);
  assert.equal(tradingOrderStatusSchema.safeParse({ ...refunded, settlementHash: undefined }).success, false);
  for (const status of ['queued', 'settling', 'unknown']) assert.equal(tradingOrderStatusSchema.safeParse({ ...base, status }).success, false);
});

test('404 confirming is normal only on status and is deposit-hash bound; status nonce stays in POST body', async () => {
  const pending = { status: 'confirming', depositHash: hash, message: 'Not available yet' };
  const { sdk, calls } = client(() => json(pending, 404));
  assert.deepEqual(await sdk.getOrderStatus({ depositHash: hash, nonce: otherHash }), pending);
  assert.equal(calls[0]!.url, 'https://priv.frontiermarkets.ai/api/v1/orders/status');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { depositHash: hash, nonce: otherHash });
  assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), `Bearer ${apiKey}`);
  await assert.rejects(sdk.getConfig(), failure('INVALID_RESPONSE'));
  await assert.rejects(sdk.quote(request()), failure('INVALID_RESPONSE'));
  for (const status of [200, 404]) {
    await assert.rejects(client(() => json({ ...pending, depositHash: otherHash }, status)).sdk.getOrderStatus({ depositHash: hash, nonce: hash }),
      failure('INVALID_RESPONSE'));
  }
  await assert.rejects(client(() => json({ ...pending, status: 'completed' }, 404)).sdk.getOrderStatus({ depositHash: hash, nonce: hash }), failure('INVALID_RESPONSE'));
  await assert.rejects(client(() => json({ error: { code: 'NOT_FOUND', message: 'super-secret' } }, 404)).sdk.getOrderStatus({ depositHash: hash, nonce: hash }),
    failure('HTTP_ERROR', 404));
});

test('response validation rejects malformed JSON, invalid UTF-8, media types, unexpected success and redirects', async () => {
  for (const response of [new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response(Uint8Array.of(0xff), { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(config())), new Response(null, { status: 204 }), json(config(), 201),
    json({ ...config(), maxAmount: (maximum + 1n).toString() }), json({ ...config(), vault: zeroAddress }),
    json({ ...config(), chainName: 'x'.repeat(129) })]) {
    await assert.rejects(client(() => response).sdk.getConfig(), failure('INVALID_RESPONSE'));
  }
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://evil.test' } }),
    Object.defineProperty(json(config()), 'redirected', { value: true })]) {
    const { sdk, calls } = client(() => response);
    await assert.rejects(sdk.getConfig(), failure('REDIRECT'));
    assert.equal(calls.length, 1);
  }
  await assert.rejects(client(() => Object.defineProperty(json(config()), 'url', { value: 'https://evil.test' })).sdk.getConfig(),
    failure('INVALID_RESPONSE'));
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(client(() => json({ error: { code: 'FORBIDDEN', message: 'super-secret https://private.provider' } }, status)).sdk.getConfig(),
      failure('HTTP_ERROR', status));
  }
  const { sdk, calls } = client(() => { throw new Error('super-secret https://private.provider'); });
  await assert.rejects(sdk.getConfig(), failure('NETWORK_ERROR'));
  assert.equal(calls.length, 1);
  const modified = new FrontierApiError('NETWORK_ERROR');
  modified.message = 'super-secret https://private.provider';
  modified.cause = { request: 'super-secret' };
  await assert.rejects(client(() => { throw modified; }).sdk.getConfig(), failure('NETWORK_ERROR'));
});

test('HTTP failure metadata exposes only finite public codes and never reflects private error fields', async () => {
  const codes = ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'INVALID_JSON', 'INVALID_PATH', 'JSON_REQUIRED',
    'BODY_TOO_LARGE', 'NOT_FOUND', 'ORIGIN_REQUIRED', 'RATE_LIMITED', 'SERVER_BUSY', 'UNAVAILABLE',
    'SERVICE_UNAVAILABLE', 'ASSET_UNAVAILABLE', 'ASSET_CAPACITY', 'NO_POOL_ROUTE', 'NO_LIQUIDITY',
    'QUOTE_SEARCH_INCOMPLETE', 'QUOTE_BUSY'] as const satisfies readonly FrontierServerCode[];
  for (const code of [...codes, 'FUTURE_PUBLIC_CODE', 'SUPER_SECRET', 'CONSTRUCTOR', 'TOSTRING']) {
    const { sdk, calls } = client(() => json({ error: { code, message: 'super-secret https://private.provider',
      cause: 'super-secret', request: { nonce: hash }, url: 'https://private.provider' } }, 503));
    await assert.rejects(sdk.quote(request()), (error: unknown) => {
      assert.ok(error instanceof FrontierApiError);
      failure('HTTP_ERROR', 503)(error);
      assert.equal(error.serverCode, codes.some((known) => known === code) ? code : undefined);
      assert.equal(error.retryAfterSeconds, undefined);
      assert.equal(Object.hasOwn(error, 'request'), false);
      assert.equal(Object.hasOwn(error, 'url'), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  for (const code of ['__PROTO__', '__proto__', 'super-secret https://private.provider']) {
    await assert.rejects(client(() => json({ error: { code, message: 'super-secret' } }, 503)).sdk.getConfig(),
      failure('INVALID_RESPONSE'));
  }
});

test('Retry-After metadata accepts only bounded numeric integer seconds without clamping or retrying', async () => {
  const cases: [string | undefined, number | undefined][] = [
    ['0', 0], ['1', 1], ['86400', 86400], ['00010', 10], [undefined, undefined], ['', undefined],
    ['-1', undefined], ['+10', undefined], ['1.5', undefined], ['1e3', undefined], ['86401', undefined],
    ['9999999999', undefined], ['9'.repeat(1000), undefined], ['00000000001', undefined],
    ['Thu, 01 Jan 2037 00:00:00 GMT', undefined], ['10, 20', undefined], ['Infinity', undefined],
    ['super-secret https://private.provider', undefined],
  ];
  for (const [header, expected] of cases) {
    const { sdk, calls } = client(() => {
      const response = json({ error: { code: 'RATE_LIMITED', message: 'super-secret' } }, 429);
      if (header !== undefined) response.headers.set('Retry-After', header);
      return response;
    });
    await assert.rejects(sdk.getAssets(), (error: unknown) => {
      assert.ok(error instanceof FrontierApiError);
      failure('HTTP_ERROR', 429)(error);
      assert.equal(error.serverCode, 'RATE_LIMITED');
      assert.equal(error.retryAfterSeconds, expected);
      assert.equal(Object.hasOwn(error, 'headers'), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('HTTP metadata survives nested reconstruction but modified metadata and provider exceptions are sanitized', async () => {
  const nested = client(({ url }) => {
    if (url.endsWith('/assets')) return json(assets());
    const response = json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'super-secret' } }, 503);
    response.headers.set('Retry-After', '30');
    return response;
  });
  await assert.rejects(nested.sdk.prepareTrade({ request: request(), quote: quote(), sender }), (error: unknown) => {
    assert.ok(error instanceof FrontierApiError);
    failure('HTTP_ERROR', 503)(error);
    assert.equal(error.serverCode, 'SERVICE_UNAVAILABLE');
    assert.equal(error.retryAfterSeconds, 30);
    return true;
  });
  for (const retryAfterSeconds of [-1, 86401, 1.5, NaN, Infinity, 'super-secret']) {
    const modified = Object.assign(new FrontierApiError('HTTP_ERROR', 503), {
      message: 'super-secret https://private.provider', cause: 'super-secret', url: 'https://private.provider',
      serverCode: 'SUPER_SECRET', retryAfterSeconds,
    });
    await assert.rejects(client(() => { throw modified; }).sdk.getConfig(), (error: unknown) => {
      assert.ok(error instanceof FrontierApiError);
      failure('HTTP_ERROR', 503)(error);
      assert.notEqual(error, modified);
      assert.equal(error.serverCode, undefined);
      assert.equal(error.retryAfterSeconds, undefined);
      assert.equal(Object.hasOwn(error, 'url'), false);
      return true;
    });
  }
  const modified = Object.assign(new FrontierApiError('HTTP_ERROR', 503, {
    serverCode: 'QUOTE_BUSY', retryAfterSeconds: 10,
  }), { message: 'super-secret', cause: 'super-secret' });
  await assert.rejects(client(() => { throw modified; }).sdk.getConfig(), (error: unknown) => {
    assert.ok(error instanceof FrontierApiError);
    failure('HTTP_ERROR', 503)(error);
    assert.notEqual(error, modified);
    assert.equal(error.serverCode, 'QUOTE_BUSY');
    assert.equal(error.retryAfterSeconds, 10);
    return true;
  });
  const networkError = new FrontierApiError('NETWORK_ERROR', undefined, { serverCode: 'QUOTE_BUSY', retryAfterSeconds: 10 });
  assert.equal(networkError.serverCode, undefined);
  assert.equal(networkError.retryAfterSeconds, undefined);
});

test('asset schema rejects ambiguous addresses, unsafe metadata URLs and invalid multipliers', async () => {
  const asset = assets().assets[0]!;
  for (const value of [{ ...assets(), assets: [asset, asset] },
    ...[{ multiplier: '0' }, { multiplier: '1e18' }, { multiplier: '1.0000000000000000001' },
      { multiplier: '9'.repeat(97) }, { decimals: 6 }, { logoUrl: 'javascript:alert(1)' },
      { logoUrl: 'https://user:pass@example.test/image' }].map((patch) => ({ ...assets(), assets: [{ ...asset, ...patch }] }))]) {
    await assert.rejects(client(() => json(value)).sdk.getAssets(), failure('INVALID_RESPONSE'));
  }
});

test('body limits cover declared length and streamed bytes, cancel oversized readers without awaiting cancellation', async () => {
  let declaredCancelled = false;
  const declared = new Response(new ReadableStream({ cancel() { declaredCancelled = true; } }), {
    headers: { 'Content-Type': 'application/json', 'Content-Length': '4194305' },
  });
  await assert.rejects(client(() => declared).sdk.getAssets(), failure('BODY_TOO_LARGE'));
  assert.equal(declaredCancelled, true);
  let cancelled = false;
  const streamed = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(33)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(client(() => streamed, { maxResponseBytes: 32 }).sdk.getConfig(), failure('BODY_TOO_LARGE'));
  assert.equal(cancelled, true);
  await assert.rejects(client(() => new Response(' '.repeat(16_385), { headers: { 'Content-Type': 'application/json' } })).sdk.getConfig(),
    failure('BODY_TOO_LARGE'));
});

test('timeouts race injected fetch and stalled body even if abort is ignored; quote timeout is independent', async () => {
  const hanging = () => new Promise<Response>(() => {});
  const { sdk, calls } = client(hanging, { timeoutMs: 15, quoteTimeoutMs: 20 });
  await assert.rejects(sdk.getConfig(), failure('TIMEOUT'));
  await assert.rejects(sdk.quote(request()), failure('TIMEOUT'));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.init.signal?.aborted));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => {}); } });
  await assert.rejects(client(() => new Response(body, { headers: { 'Content-Type': 'application/json' } }), { timeoutMs: 15 }).sdk.getConfig(),
    failure('TIMEOUT'));
  assert.equal(cancelled, true);
  const delayed = client(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return json(quote()); },
    { timeoutMs: 5, quoteTimeoutMs: 100 });
  assert.deepEqual(await delayed.sdk.quote(request()), quote());
});

test('default timers are exactly 30 seconds for reads and 50 seconds for quotes', async (t) => {
  const delays: (number | undefined)[] = [];
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    delays.push(args[1]);
    return original(...args);
  });
  const controller = new AbortController();
  const { sdk } = client(() => new Promise<Response>(() => {}));
  const reads = assert.rejects(sdk.getConfig({ signal: controller.signal }), failure('CANCELLED'));
  const quotes = assert.rejects(sdk.quote(request(), { signal: controller.signal }), failure('CANCELLED'));
  assert.deepEqual(delays, [30_000, 50_000]);
  controller.abort();
  await Promise.all([reads, quotes]);
});

test('caller cancellation handles pre-abort, ignored abort, late response cleanup and private abort reasons safely', async () => {
  const controller = new AbortController();
  const early = client(() => json(config()));
  controller.abort(new Error('super-secret'));
  await assert.rejects(early.sdk.getConfig({ signal: controller.signal }), failure('CANCELLED'));
  assert.equal(early.calls.length, 0);
  let resolveFetch!: (response: Response) => void;
  const late = client(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
  const pendingController = new AbortController();
  const pending = late.sdk.getConfig({ signal: pendingController.signal });
  pendingController.abort('super-secret');
  await assert.rejects(pending, failure('CANCELLED'));
  assert.equal(late.calls.length, 1);
  assert.equal(late.calls[0]!.init.signal!.aborted, true);
  let cancelled = false;
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('per-client Date clock follows monotonic elapsed time and never moves back on later Date headers', async () => {
  let date = now;
  let value = quote();
  const first = client(({ url }) => json(url.endsWith('/config') ? config() : value, 200, date));
  await first.sdk.getConfig();
  date = now + 100;
  await first.sdk.getConfig();
  date = now;
  await assert.rejects(first.sdk.quote(request()), failure('QUOTE_EXPIRED'));
  assert.deepEqual(await client(() => json(quote())).sdk.quote(request()), quote());
  value = quote(false, { quotedAt: now + 100, expiresAt: now + 160 });
  assert.deepEqual(await first.sdk.quote(request()), value);
});

test('monotonic elapsed time expires quotes even with stale/missing Date headers and a backwards local wall clock', async (t) => {
  let elapsed = 0;
  let wall = now * 1000;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(Date, 'now', () => wall);
  for (const withDate of [true, false]) {
    elapsed = 0; wall = now * 1000;
    const { sdk } = client(({ url }) => {
      const response = json(url.endsWith('/config') ? config() : quote());
      if (!withDate) response.headers.delete('Date');
      return response;
    });
    await sdk.getConfig();
    elapsed = 61_000; wall -= 1_000_000;
    await assert.rejects(sdk.quote(request()), failure('QUOTE_EXPIRED'));
  }
});

test('prepare buy and sell use exact local calldata, decrypt to reviewed intent, and only sells report allowance', async () => {
  for (const sell of [false, true]) {
    const reviewed = quote(sell, { minAmountOut: '10000' });
    const { sdk, calls } = client(({ url }) => json(url.endsWith('/config') ? config() : assets()),
      { expectedVault: vault, expectedEncryptionPublicKey: keys.publicKey });
    const result = await sdk.prepareTrade({ request: request(sell), quote: reviewed, sender, recipient });
    assert.equal(result.transaction.to, vault); assert.equal(result.transaction.chainId, 4663);
    assert.equal(result.transaction.value, sell ? 0n : BigInt(request().amount));
    const decoded = decodeFunctionData({ abi: tradingVaultAbi, data: result.transaction.data });
    let envelope: Hex;
    if (sell) {
      assert.equal(decoded.functionName, 'depositToken');
      assert.ok(decoded.functionName === 'depositToken');
      assert.deepEqual(decoded.args.slice(0, 2), [stock, BigInt(request().amount)]);
      envelope = decoded.args[2];
      assert.equal(result.transaction.data, encodeFunctionData({ abi: tradingVaultAbi, functionName: 'depositToken',
        args: [stock, BigInt(request().amount), envelope] }));
      assert.deepEqual(result.allowanceRequirement, { token: stock, owner: sender, spender: vault, amount: BigInt(request().amount) });
    } else {
      assert.equal(decoded.functionName, 'deposit'); assert.ok(decoded.functionName === 'deposit');
      envelope = decoded.args[0];
      assert.equal(result.transaction.data, encodeFunctionData({ abi: tradingVaultAbi, functionName: 'deposit', args: [envelope] }));
      assert.equal(Object.hasOwn(result, 'allowanceRequirement'), false);
    }
    assert.equal(envelope.length, 2 + 1072 * 2);
    assert.deepEqual(await decryptTrade(envelope, keys), result.intent);
    assert.deepEqual(result.intent, { version: 2, chainId: 4663, vault, sender, recipient,
      assetIn: reviewed.assetIn, assetOut: reviewed.assetOut, amount: request().amount,
      minAmountOut: '10000', maxFee: '0', deadline: now + 1800, nonce: result.intent.nonce });
    assert.match(result.intent.nonce, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname).sort(), ['/api/v1/assets', '/api/v1/config']);
    assert.ok(calls.every((call) => call.init.method === 'GET' && call.init.body === undefined));
    const second = await sdk.prepareTrade({ request: request(sell), quote: reviewed, sender });
    assert.equal(second.intent.recipient, sender);
    assert.notEqual(second.intent.nonce, result.intent.nonce);
    assert.notEqual(second.transaction.data, result.transaction.data);
  }
});

test('prepare snapshots caller-owned request, quote, sender and recipient before fetching', async () => {
  const params = { request: request(), quote: quote(), sender, recipient };
  const { sdk } = client(({ url }) => {
    params.request.amount = '2'; params.quote.minAmountOut = '1'; params.quote.poolFees[0] = 999999;
    params.sender = address(900); params.recipient = address(901);
    return json(url.endsWith('/config') ? config() : assets());
  });
  const result = await sdk.prepareTrade(params);
  assert.equal(result.intent.amount, request().amount); assert.equal(result.intent.minAmountOut, quote().minAmountOut);
  assert.equal(result.intent.sender, sender); assert.equal(result.intent.recipient, recipient);
});

test('prepare fails closed on fresh readiness, config/asset changes, fee/minimum mismatch and pins', async () => {
  for (const patch of [{ paused: true }, { acceptingOrders: false }, { vault: null }, { encryptionPublicKey: null },
    { service: { ...config().service, state: 'degraded' as const } },
    { service: { ...config().service, lastHeartbeatAt: null } },
    { service: { ...config().service, lastHeartbeatAt: now - 61 } },
    { service: { ...config().service, lastHeartbeatAt: now + 6 } }]) {
    const { sdk } = client(({ url }) => json(url.endsWith('/config') ? config(patch) : assets()));
    await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(), sender }), failure('NOT_READY'));
  }
  for (const patch of [{ vault: address(999) }, { maxAmount: '1' }, { feeBps: 1 },
    { defaultSlippageBps: 25, maxSlippageBps: 25 }]) {
    const { sdk } = client(({ url }) => json(url.endsWith('/config') ? config(patch) : assets()));
    await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(), sender }), failure('QUOTE_MISMATCH'));
  }
  for (const catalog of [{ ...assets(), assets: [] },
    { ...assets(), assets: [{ ...assets().assets[0]!, enabled: false }] }]) {
    const { sdk } = client(({ url }) => json(url.endsWith('/config') ? config() : catalog));
    await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(), sender }), failure('NOT_READY'));
  }
  for (const options of [{ expectedVault: address(999) }, { expectedEncryptionPublicKey: otherHash }]) {
    const { sdk } = client(({ url }) => json(url.endsWith('/config') ? config() : assets()), options);
    await assert.rejects(sdk.getConfig(), failure('PIN_MISMATCH'));
    await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(), sender }), failure('PIN_MISMATCH'));
  }
  const { sdk, calls } = client(({ url }) => json(url.endsWith('/config') ? config() : assets()));
  await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(false, { minAmountOut: '1' }), sender }), failure('INVALID_REQUEST'));
  assert.equal(calls.length, 0);
  await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(false, { feeAmount: '1' }), sender }), failure('QUOTE_MISMATCH'));
  await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(), sender, recipient: vault }), failure('INVALID_REQUEST'));
  await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(false, { expiresAt: now + 2 }), sender }), failure('QUOTE_EXPIRED'));
});

test('prepare cancellation/timeout races both fresh reads, and invalid encryption keys cannot produce a transaction', async () => {
  const { sdk, calls } = client(() => new Promise<Response>(() => {}), { timeoutMs: 15 });
  await assert.rejects(sdk.prepareTrade({ request: request(), quote: quote(), sender }), failure('TIMEOUT'));
  assert.equal(calls.length, 2); assert.ok(calls.every((call) => call.init.signal?.aborted));
  const invalidKey: Hex = `0x${'00'.repeat(32)}`;
  const broken = client(({ url }) => json(url.endsWith('/config') ? config({ encryptionPublicKey: invalidKey }) : assets()));
  await assert.rejects(broken.sdk.prepareTrade({ request: request(), quote: quote(), sender }), failure('PREPARE_FAILED'));
});

test('prepare rechecks fresh encryption-key pins and rejects a quote that expires during the fresh reads', async () => {
  const params = { request: request(), quote: quote(), sender };
  let currentConfig = config();
  const pinned = client(({ url }) => json(url.endsWith('/config') ? currentConfig : assets()),
    { expectedEncryptionPublicKey: keys.publicKey });
  await pinned.sdk.getConfig();
  currentConfig = config({ encryptionPublicKey: (await generateEncryptionKeyPair()).publicKey });
  await assert.rejects(pinned.sdk.prepareTrade(params), failure('PIN_MISMATCH'));
  const expired = client(({ url }) => json(url.endsWith('/config') ? config() : assets(), 200,
    url.endsWith('/config') ? now : now + 59));
  await assert.rejects(expired.sdk.prepareTrade(params), failure('QUOTE_EXPIRED'));
  const controller = new AbortController();
  const cancelled = client(() => new Promise<Response>(() => {}));
  const pending = cancelled.sdk.prepareTrade(params, { signal: controller.signal });
  controller.abort(new Error('super-secret'));
  await assert.rejects(pending, failure('CANCELLED'));
  assert.ok(cancelled.calls.every((call) => call.init.signal?.aborted));
});
