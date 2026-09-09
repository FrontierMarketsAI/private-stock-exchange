import type { Address, Hex } from 'viem';
import { z } from 'zod';
import {
  apiErrorSchema, tradingAssetsSchema, tradingConfigSchema, tradingOrderStatusSchema,
  tradingQuoteRequestSchema, tradingQuoteSchema, tradingStatusRequestSchema,
  type TradingAssetsResponse, type TradingConfig, type TradingOrderStatus, type TradingQuote,
  type TradingQuoteRequest, type TradingStatusRequest,
} from '../shared/trading-api.js';
import { buildTradeDepositTransaction, type BuildTradeDepositResult } from '../sdk/trading.js';

export { buildTradeDepositTransaction, encryptTrade, validateTradeIntent,
  TRADE_MAX_AMOUNT, TRADE_PLAINTEXT_BYTES, TRADE_ENVELOPE_BYTES } from '../sdk/trading.js';
export type { BuildTradeDepositParams, BuildTradeDepositResult, TradeIntent } from '../sdk/trading.js';
export type { DepositTransaction, BuildDepositOptions } from '../sdk/orders.js';
export type { TradingConfig, TradingAsset, TradingAssetsResponse, TradingQuoteRequest, TradingQuote,
  TradingStatusRequest, TradingOrderStatus, TradeSide, ApiErrorResponse } from '../shared/trading-api.js';

export interface FrontierClientOptions {
  /** Server-side API credential, never a wallet or encryption private key. */
  apiKey: string;
  /** Origin only, without an API path, query, fragment, or credentials. */
  baseUrl?: string;
  allowInsecureLocalhost?: boolean;
  fetch?: typeof globalThis.fetch;
  /** Default 30 seconds; quote requests default to 50 seconds independently. */
  timeoutMs?: number;
  quoteTimeoutMs?: number;
  /** Maximum decoded response bytes, default and ceiling 4 MiB. */
  maxResponseBytes?: number;
  expectedVault?: Address;
  expectedEncryptionPublicKey?: Hex;
}
export interface FrontierRequestOptions { signal?: AbortSignal }
export interface PrepareTradeParams {
  request: TradingQuoteRequest;
  quote: TradingQuote;
  sender: Address;
  recipient?: Address;
}
export interface AllowanceRequirement { token: Address; owner: Address; spender: Address; amount: bigint }
export interface PrepareTradeResult extends BuildTradeDepositResult {
  /** Present only for sells. The caller must check allowance and explicitly approve if necessary. */
  allowanceRequirement?: AllowanceRequirement;
}

const messages = {
  INVALID_OPTIONS: 'Invalid Frontier client options.',
  INVALID_REQUEST: 'Invalid request parameters.',
  INVALID_RESPONSE: 'The service returned an invalid response.',
  BODY_TOO_LARGE: 'The service response exceeded the size limit.',
  REDIRECT: 'Redirects are not allowed.',
  TIMEOUT: 'The request timed out.',
  CANCELLED: 'The request was cancelled.',
  NETWORK_ERROR: 'The service could not be reached.',
  HTTP_ERROR: 'The service could not complete the request.',
  PIN_MISMATCH: 'The service configuration does not match the expected vault or encryption key.',
  QUOTE_MISMATCH: 'The quote does not match the reviewed request or current configuration.',
  QUOTE_EXPIRED: 'The quote is expired or has an invalid timestamp. Review a fresh quote.',
  NOT_READY: 'Trading or the selected asset is not accepting orders.',
  PREPARE_FAILED: 'The local trade transaction could not be prepared.',
} as const;
export type FrontierErrorCode = keyof typeof messages;

const serverCodeSchema = z.enum([
  'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST', 'INVALID_JSON', 'INVALID_PATH', 'JSON_REQUIRED',
  'BODY_TOO_LARGE', 'NOT_FOUND', 'ORIGIN_REQUIRED', 'RATE_LIMITED', 'SERVER_BUSY', 'UNAVAILABLE',
  'SERVICE_UNAVAILABLE', 'ASSET_UNAVAILABLE', 'ASSET_CAPACITY', 'NO_POOL_ROUTE', 'NO_LIQUIDITY',
  'QUOTE_SEARCH_INCOMPLETE', 'QUOTE_BUSY',
]);
const retryAfterSchema = z.number().int().min(0).max(86_400);
export type FrontierServerCode = z.infer<typeof serverCodeSchema>;
export interface FrontierHttpFailureMetadata {
  serverCode?: FrontierServerCode;
  retryAfterSeconds?: number;
}

/** No upstream message, cause, URL, headers, request, or private inputs are attached. */
export class FrontierApiError extends Error {
  readonly serverCode?: FrontierServerCode;
  readonly retryAfterSeconds?: number;

  constructor(public readonly code: FrontierErrorCode, public readonly status?: number,
    metadata: FrontierHttpFailureMetadata = {}) {
    super(messages[code]);
    this.name = 'FrontierApiError';
    if (code === 'HTTP_ERROR') {
      const serverCode = serverCodeSchema.safeParse(metadata.serverCode);
      const retryAfter = retryAfterSchema.safeParse(metadata.retryAfterSeconds);
      if (serverCode.success) this.serverCode = serverCode.data;
      if (retryAfter.success) this.retryAfterSeconds = retryAfter.data;
    }
  }
}

const nonzeroAddress = tradingQuoteRequestSchema.shape.stock;
const hash = tradingStatusRequestSchema.shape.nonce;
const prepareSchema = z.object({ request: tradingQuoteRequestSchema, quote: tradingQuoteSchema,
  sender: nonzeroAddress, recipient: nonzeroAddress.optional() }).strict();
const milliseconds = z.number().int().min(1).max(300_000);
const optionsSchema = z.object({
  apiKey: z.string().min(1).max(4096).regex(/^[A-Za-z0-9._~+\/-]+=*$/),
  baseUrl: z.string().min(1).max(2048).optional(), allowInsecureLocalhost: z.boolean().optional(),
  fetch: z.custom<typeof globalThis.fetch>((value) => typeof value === 'function').optional(),
  timeoutMs: milliseconds.optional(), quoteTimeoutMs: milliseconds.optional(),
  maxResponseBytes: z.number().int().min(1).max(4_194_304).optional(),
  expectedVault: nonzeroAddress.optional(), expectedEncryptionPublicKey: hash.optional(),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown, code: FrontierErrorCode): T {
  try { return schema.parse(value); } catch { throw new FrontierApiError(code); }
}

export class FrontierClient {
  // ECMAScript private fields keep credentials out of logging/inspection and JSON serialization.
  #options: z.infer<typeof optionsSchema>;
  #origin: string;
  #fetch: typeof globalThis.fetch;
  #clock = { epoch: Date.now(), at: performance.now(), server: false };

  constructor(options: FrontierClientOptions) {
    this.#options = parse(optionsSchema, options, 'INVALID_OPTIONS');
    try {
      const raw = this.#options.baseUrl ?? 'https://priv.frontiermarkets.ai';
      const url = new URL(raw);
      const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
        || /^127(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(url.hostname);
      if (raw !== raw.trim() || /[\\\x00-\x20]/.test(raw) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || raw.includes('?') || raw.includes('#')
        || !/^https?:\/\/[^/]+\/?$/.test(raw)
        || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && this.#options.allowInsecureLocalhost)) {
        throw new Error();
      }
      this.#origin = url.origin;
      this.#fetch = this.#options.fetch ?? globalThis.fetch;
      if (typeof this.#fetch !== 'function') throw new Error();
    } catch { throw new FrontierApiError('INVALID_OPTIONS'); }
  }

  #now(): number { return Math.floor((this.#clock.epoch + performance.now() - this.#clock.at) / 1000); }

  async #run<T>(options: FrontierRequestOptions, timeout: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const external = options.signal;
    if (external?.aborted) throw new FrontierApiError('CANCELLED');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => { reject(new FrontierApiError('CANCELLED')); controller.abort(); };
      external?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { reject(new FrontierApiError('TIMEOUT')); controller.abort(); }, timeout);
    });
    try {
      // Race the entire operation, not just fetch: injected transports/streams may ignore abort.
      return await Promise.race([interrupted, task(controller.signal)]);
    } catch (error) {
      if (error instanceof FrontierApiError && Object.hasOwn(messages, error.code)) {
        // Reconstruct even our error type: an injected transport can throw a modified instance.
        const status = error.status;
        throw new FrontierApiError(error.code,
          typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
          error);
      }
      throw new FrontierApiError('NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  async #http<T>(path: 'config' | 'assets' | 'quote' | 'orders/status', schema: z.ZodType<T>,
    options: FrontierRequestOptions, body?: TradingQuoteRequest | TradingStatusRequest): Promise<T> {
    const timeout = path === 'quote' ? this.#options.quoteTimeoutMs ?? 50_000 : this.#options.timeoutMs ?? 30_000;
    return this.#run(options, timeout, async (signal) => {
      const url = `${this.#origin}/api/v1/${path}`;
      const response = await this.#fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.#options.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cancelBody = () => {
        try { void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {}); } catch { /* Best effort only. */ }
      };
      signal.addEventListener('abort', cancelBody, { once: true });
      try {
        if (signal.aborted) { cancelBody(); throw new FrontierApiError('CANCELLED'); }
        if (response.redirected || response.status >= 300 && response.status < 400 || response.type === 'opaqueredirect') {
          throw new FrontierApiError('REDIRECT');
        }
        if (response.url && response.url !== url || response.type === 'opaque'
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
          throw new FrontierApiError('INVALID_RESPONSE');
        }
        const maximum = Math.min(this.#options.maxResponseBytes ?? 4_194_304, path === 'assets' ? 4_194_304 : 16_384);
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new FrontierApiError('BODY_TOO_LARGE');
        const receivedAt = performance.now();
        const serverDate = Date.parse(response.headers.get('date') ?? '');
        if (!response.body) throw new FrontierApiError('INVALID_RESPONSE');
        reader = response.body.getReader();
        const bytes = new Uint8Array(maximum);
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (signal.aborted) throw new FrontierApiError('CANCELLED');
          if (chunk.done) break;
          if (size + chunk.value.byteLength > maximum) throw new FrontierApiError('BODY_TOO_LARGE');
          bytes.set(chunk.value, size);
          size += chunk.value.byteLength;
        }
        let data: unknown;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
        catch { throw new FrontierApiError('INVALID_RESPONSE'); }
        if (response.status !== 200) {
          const pending = path === 'orders/status' && response.status === 404
            ? tradingOrderStatusSchema.safeParse(data) : undefined;
          if (!pending?.success || pending.data.status !== 'confirming') {
            const failure = parse(apiErrorSchema, data, 'INVALID_RESPONSE');
            const serverCode = serverCodeSchema.safeParse(failure.error.code);
            const retryAfter = response.headers.get('retry-after');
            // Only numeric delay-seconds are considered; the error constructor enforces the bound.
            throw new FrontierApiError('HTTP_ERROR', response.status, {
              ...(serverCode.success ? { serverCode: serverCode.data } : {}),
              ...(retryAfter !== null && retryAfter.length <= 10 && /^\d+$/.test(retryAfter)
                ? { retryAfterSeconds: Number(retryAfter) } : {}),
            });
          }
        }
        const result = parse(schema, data, 'INVALID_RESPONSE');
        if (Number.isFinite(serverDate)) {
          const previous = this.#clock.epoch + receivedAt - this.#clock.at;
          this.#clock = { epoch: this.#clock.server ? Math.max(previous, serverDate) : serverDate,
            at: receivedAt, server: true };
        }
        return result;
      } finally {
        signal.removeEventListener('abort', cancelBody);
        cancelBody();
      }
    });
  }

  #pins(config: TradingConfig): void {
    if (this.#options.expectedVault && config.vault !== this.#options.expectedVault
      || this.#options.expectedEncryptionPublicKey && config.encryptionPublicKey !== this.#options.expectedEncryptionPublicKey) {
      throw new FrontierApiError('PIN_MISMATCH');
    }
  }

  async getConfig(options: FrontierRequestOptions = {}): Promise<TradingConfig> {
    const config = await this.#http('config', tradingConfigSchema, options);
    this.#pins(config);
    return config;
  }

  async getAssets(options: FrontierRequestOptions = {}): Promise<TradingAssetsResponse> {
    return this.#http('assets', tradingAssetsSchema, options);
  }

  #bind(request: TradingQuoteRequest, quote: TradingQuote): void {
    if (quote.stock !== request.stock || quote.side !== request.side || quote.amountIn !== request.amount
      || quote.slippageBps !== request.slippageBps
      || this.#options.expectedVault && quote.vault !== this.#options.expectedVault) {
      throw new FrontierApiError('QUOTE_MISMATCH');
    }
    const now = this.#now();
    if (quote.quotedAt > now + 5 || quote.quotedAt < now - 60 || quote.expiresAt <= now + 2) {
      throw new FrontierApiError('QUOTE_EXPIRED');
    }
  }

  async quote(request: TradingQuoteRequest, options: FrontierRequestOptions = {}): Promise<TradingQuote> {
    const snapshot = parse(tradingQuoteRequestSchema, request, 'INVALID_REQUEST');
    const quote = await this.#http('quote', tradingQuoteSchema, options, snapshot);
    this.#bind(snapshot, quote);
    return quote;
  }

  async getOrderStatus(request: TradingStatusRequest, options: FrontierRequestOptions = {}): Promise<TradingOrderStatus> {
    const snapshot = parse(tradingStatusRequestSchema, request, 'INVALID_REQUEST');
    const status = await this.#http('orders/status', tradingOrderStatusSchema, options, snapshot);
    if (status.depositHash !== snapshot.depositHash) throw new FrontierApiError('INVALID_RESPONSE');
    return status;
  }

  async prepareTrade(params: PrepareTradeParams, options: FrontierRequestOptions = {}): Promise<PrepareTradeResult> {
    // Parse before the first await, including a deep copy of the reviewed quote and its fee array.
    const { request, quote, sender, recipient } = parse(prepareSchema, params, 'INVALID_REQUEST');
    return this.#run(options, this.#options.timeoutMs ?? 30_000, async (signal) => {
      const [config, catalog] = await Promise.all([this.getConfig({ signal }), this.getAssets({ signal })]);
      const asset = catalog.assets.find((value) => value.address === request.stock);
      const now = this.#now();
      if (!config.acceptingOrders || config.paused || config.service.state !== 'online'
        || config.service.lastHeartbeatAt === null || config.service.lastHeartbeatAt < now - 60
        || config.service.lastHeartbeatAt > now + 5
        || !config.vault || !config.encryptionPublicKey || !asset?.enabled || asset.unavailableReason !== null) {
        throw new FrontierApiError('NOT_READY');
      }
      this.#bind(request, quote);
      // V2 currently supports zero service fees only. Pool fees are already included in amountOut.
      // Wire outputs are uint256, but the local encrypted intent minimum must fit uint128.
      if (config.feeBps !== 0 || quote.feeAmount !== '0' || quote.vault !== config.vault
        || quote.chainId !== config.chainId || request.slippageBps > config.maxSlippageBps
        || BigInt(quote.minAmountOut) > (1n << 128n) - 1n
        || BigInt(request.amount) > BigInt(config.maxAmount)) throw new FrontierApiError('QUOTE_MISMATCH');
      if (recipient === config.vault || sender === config.vault || sender === asset.address) {
        throw new FrontierApiError('INVALID_REQUEST');
      }
      if (signal.aborted) throw new FrontierApiError('CANCELLED');
      let result: BuildTradeDepositResult;
      try {
        result = await buildTradeDepositTransaction({ chainId: config.chainId, vault: config.vault, sender,
          recipient: recipient ?? sender, assetIn: quote.assetIn, assetOut: quote.assetOut, amount: BigInt(request.amount),
          minAmountOut: BigInt(quote.minAmountOut), maxFee: BigInt(quote.feeAmount),
          deadline: this.#now() + config.orderLifetimeSeconds, encryptionPublicKey: config.encryptionPublicKey,
        }, { now: () => this.#now() });
      } catch { throw new FrontierApiError('PREPARE_FAILED'); }
      if (signal.aborted) throw new FrontierApiError('CANCELLED');
      this.#bind(request, quote);
      return { ...result, ...(request.side === 'sell' ? { allowanceRequirement: {
        token: asset.address, owner: sender, spender: config.vault, amount: BigInt(request.amount),
      } } : {}) };
    });
  }
}
