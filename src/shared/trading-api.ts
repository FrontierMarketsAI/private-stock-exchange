import { getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

const maxAmount = (1n << 127n) - 1n;
const uint256 = (1n << 256n) - 1n;
const address = z.string().length(42).regex(/^0x[0-9a-fA-F]{40}$/)
  .describe('EVM address; mixed-case addresses must have a valid EIP-55 checksum. Normalized to checksum case.')
  .refine((value) => isAddress(value, { strict: true }), 'Invalid address checksum')
  .transform((value) => getAddress(value) as Address);
const nonzeroAddress = address.refine((value) => value !== zeroAddress, 'Address must not be zero')
  .describe('Nonzero EVM address; mixed-case addresses must have a valid EIP-55 checksum. Normalized to checksum case.');
const hash = z.string().length(66).regex(/^0x[0-9a-fA-F]{64}$/)
  .describe('32 bytes of hexadecimal, normalized to lowercase.')
  .transform((value) => value.toLowerCase() as Hex);
function integer(max: bigint, positive = true) {
  const pattern = positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/;
  return z.string().min(1).max(max.toString().length).regex(pattern)
    .describe(`Canonical decimal integer, ${positive ? '1' : '0'} through ${max}, inclusive. No sign, exponent, or leading zeroes.`)
    .refine((value) => value.length <= max.toString().length && pattern.test(value) && BigInt(value) <= max,
      'Integer out of range');
}
const seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe('Unix timestamp in seconds.');
const duration = z.number().int().positive().max(86_400);
const slippage = z.number().int().min(1).max(500);
const message = z.string().max(2048);
const httpsUrl = z.string().min(1).max(2048).url().refine((value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}, 'Expected an HTTPS URL without credentials');
const decimalPattern = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,18}))?$/;
const multiplier = z.string().min(1).max(97).regex(decimalPattern)
  .describe('Positive decimal with at most 18 fractional digits; scaled by 10^18 it must fit uint256.')
  .refine((value) => {
    if (value.length > 97 || !decimalPattern.test(value)) return false;
    const [whole = '0', fraction = ''] = value.split('.');
    const scaled = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
    return scaled > 0n && scaled <= uint256;
  });

// Output objects strip extensions. Requests reject unknown fields, including private inputs.
export const tradingConfigSchema = z.object({
  version: z.literal(2), chainId: z.literal(4663), chainName: z.string().min(1).max(128),
  vault: nonzeroAddress.nullable(), explorerUrl: httpsUrl, encryptionPublicKey: hash.nullable(),
  maxAmount: integer(maxAmount), feeBps: z.number().int().min(0).max(9999),
  minimumBatchSize: z.number().int().min(1).max(32), batchWindowSeconds: duration,
  orderLifetimeSeconds: duration, defaultSlippageBps: slippage, maxSlippageBps: slippage,
  paused: z.boolean(), acceptingOrders: z.boolean(),
  service: z.object({ state: z.enum(['starting', 'online', 'offline', 'degraded']),
    message, lastHeartbeatAt: seconds.nullable() }),
}).refine((value) => value.defaultSlippageBps <= value.maxSlippageBps, 'Invalid slippage configuration');

export const tradingAssetSchema = z.object({
  symbol: z.string().min(1).max(32).regex(/^[A-Z][A-Z0-9.-]*$/), name: z.string().min(1).max(256),
  address: nonzeroAddress, logoUrl: httpsUrl.nullable(), decimals: z.literal(18), multiplier,
  enabled: z.boolean(), unavailableReason: message.nullable(),
});
export const tradingAssetsSchema = z.object({ assets: z.array(tradingAssetSchema).max(10_000), updatedAt: seconds })
  .refine((value) => new Set(value.assets.map((asset) => asset.address)).size === value.assets.length,
    'Duplicate asset address');

export const tradingQuoteRequestSchema = z.object({
  stock: nonzeroAddress, side: z.enum(['buy', 'sell']), amount: integer(maxAmount), slippageBps: slippage,
}).strict();

export const tradingQuoteSchema = z.object({
  version: z.literal(2), chainId: z.literal(4663), vault: nonzeroAddress, stock: nonzeroAddress,
  side: z.enum(['buy', 'sell']), assetIn: address, assetOut: address, routeId: hash,
  amountIn: integer(maxAmount), feeAmount: integer(maxAmount, false),
  poolFees: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(3),
  amountOut: integer(uint256), minAmountOut: integer(uint256), slippageBps: slippage,
  quotedAt: seconds, expiresAt: seconds,
}).refine((value) => value.assetIn === (value.side === 'buy' ? zeroAddress : value.stock)
  && value.assetOut === (value.side === 'buy' ? value.stock : zeroAddress), 'Invalid quote pair')
  .refine((value) => {
    // Refinements also run after string checks fail; never parse an unbounded or malformed bigint.
    const amounts = [value.amountIn, value.feeAmount, value.amountOut, value.minAmountOut];
    if (!Number.isSafeInteger(value.slippageBps)
      || amounts.some((amount, index) => amount.length > (index < 2 ? 39 : 78)
        || !/^(0|[1-9][0-9]*)$/.test(amount))) return false;
    return BigInt(value.feeAmount) < BigInt(value.amountIn)
      && BigInt(value.minAmountOut) <= BigInt(value.amountOut)
      && BigInt(value.minAmountOut) >= BigInt(value.amountOut) * BigInt(10_000 - value.slippageBps) / 10_000n;
  }, 'Invalid quote fee or minimum output')
  .refine((value) => value.expiresAt > value.quotedAt && value.expiresAt - value.quotedAt <= 60,
    'Quote lifetime must be at most 60 seconds');

export const tradingStatusRequestSchema = z.object({ depositHash: hash, nonce: hash }).strict();
const statusBase = { depositHash: hash, message };
const authenticatedBase = { ...statusBase, expiresAt: seconds, assetIn: address, assetOut: address };
export const tradingOrderStatusSchema = z.discriminatedUnion('status', [
  z.object({ ...statusBase, status: z.literal('confirming') }),
  z.object({ ...authenticatedBase, status: z.literal('processing') }),
  z.object({ ...authenticatedBase, status: z.literal('attention') }),
  z.object({ ...authenticatedBase, status: z.literal('completed'), outputAmount: integer(uint256),
    payoutAddress: nonzeroAddress, recipient: nonzeroAddress }),
  z.object({ ...authenticatedBase, status: z.literal('refunded'), settlementHash: hash,
    outputAmount: integer(maxAmount), recipient: nonzeroAddress }),
]);
export const apiErrorSchema = z.object({ error: z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/), message,
}) });

export type TradeSide = z.infer<typeof tradingQuoteRequestSchema>['side'];
export interface TradingConfig extends z.infer<typeof tradingConfigSchema> {}
export interface TradingAsset extends z.infer<typeof tradingAssetSchema> {}
export interface TradingAssetsResponse extends z.infer<typeof tradingAssetsSchema> {}
export interface TradingQuoteRequest extends z.infer<typeof tradingQuoteRequestSchema> {}
export interface TradingQuote extends z.infer<typeof tradingQuoteSchema> {}
export interface TradingStatusRequest extends z.infer<typeof tradingStatusRequestSchema> {}
export type TradingOrderStatus = z.infer<typeof tradingOrderStatusSchema>;
export interface ApiErrorResponse extends z.infer<typeof apiErrorSchema> {}
