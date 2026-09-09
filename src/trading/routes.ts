import { encodeAbiParameters, keccak256, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { PoolKey } from '../sdk/routes.js';
import { addressSchema, bytes32Schema, nonzeroAddressSchema } from '../sdk/validation.js';
import type { TradeRoute } from './types.js';

export const ROBINHOOD_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;

const poolsSchema = z.array(z.object({
  currency0: addressSchema, currency1: addressSchema,
  fee: z.number().int().min(0).max(1_000_000),
  tickSpacing: z.number().int().min(1).max(32767),
  hooks: addressSchema.refine((value) => value === zeroAddress, 'Hooks are not allowed'),
}).strict().refine((pool) => BigInt(pool.currency0) < BigInt(pool.currency1), 'Currencies must be strictly sorted')).min(1).max(3);

/** Solidity parity: keccak256(abi.encode(stock, sell, wrapped, pools)), never packed. */
export function getTradeRouteId(stock: Address, sell: boolean, wrapped: boolean, pools: readonly PoolKey[]): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters(
    'address stock, bool sell, bool wrapped, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)[] pools',
  ), [nonzeroAddressSchema.parse(stock), z.boolean().parse(sell), z.boolean().parse(wrapped), poolsSchema.parse(pools)]));
}

/** Pure path validation, not an attestation of stock identity, activation, or liquidity. */
export function validateTradeRoute(route: TradeRoute, weth: Address, usdg: Address): TradeRoute {
  const wrappedNative = nonzeroAddressSchema.parse(weth);
  const bridge = nonzeroAddressSchema.parse(usdg);
  const parsed = z.object({
    id: bytes32Schema, stock: nonzeroAddressSchema, sell: z.boolean(), wrapped: z.boolean(),
    pools: poolsSchema, assetIn: addressSchema, assetOut: addressSchema,
  }).strict().parse(route);
  if (wrappedNative === bridge || parsed.stock === wrappedNative || parsed.stock === bridge) throw new Error('Invalid stock currency');
  if (parsed.assetIn !== (parsed.sell ? parsed.stock : zeroAddress)
    || parsed.assetOut !== (parsed.sell ? zeroAddress : parsed.stock)) throw new Error('Route asset pair mismatch');
  const nativeLeg = parsed.wrapped ? wrappedNative : zeroAddress;
  let currency = parsed.sell ? parsed.stock : nativeLeg;
  const target = parsed.sell ? nativeLeg : parsed.stock;
  const allowed = new Set([zeroAddress, wrappedNative, bridge, parsed.stock]);
  const visited = new Set([currency]);
  for (const pool of parsed.pools) {
    if (!allowed.has(pool.currency0) || !allowed.has(pool.currency1)) throw new Error('Unapproved intermediate currency');
    if (currency === pool.currency0) currency = pool.currency1;
    else if (currency === pool.currency1) currency = pool.currency0;
    else throw new Error('Route is not contiguous');
    if (visited.has(currency)) throw new Error('Route contains a cycle');
    visited.add(currency);
  }
  if (currency !== target) throw new Error('Route endpoint mismatch');
  if (getTradeRouteId(parsed.stock, parsed.sell, parsed.wrapped, parsed.pools) !== parsed.id) throw new Error('Route ID mismatch');
  return parsed;
}
