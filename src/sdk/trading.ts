import sodium from 'libsodium-wrappers';
import { bytesToHex, encodeFunctionData, hexToBytes, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { EncryptionKeyPair, DepositTransaction, BuildDepositOptions } from './orders.js';
import { addressSchema, bytes32Schema, decimalIntegerSchema, nonzeroAddressSchema, positiveSafeIntegerSchema, UINT128_MAX } from './validation.js';
import { tradingVaultAbi } from '../trading/abi.js';
import type { TradeIntent } from '../trading/types.js';

export { getTradeRouteId, validateTradeRoute } from '../trading/routes.js';
export type { TradeIntent, TradeRoute } from '../trading/types.js';

export const TRADE_PLAINTEXT_BYTES = 1024;
export const TRADE_ENVELOPE_BYTES = 1072;
export const TRADE_MAX_AMOUNT = (1n << 127n) - 1n;

const tradeSchema = z.object({
  version: z.literal(2), chainId: positiveSafeIntegerSchema,
  vault: nonzeroAddressSchema, sender: nonzeroAddressSchema,
  assetIn: addressSchema, assetOut: addressSchema,
  amount: decimalIntegerSchema(TRADE_MAX_AMOUNT, true), recipient: nonzeroAddressSchema,
  minAmountOut: decimalIntegerSchema(UINT128_MAX, true), maxFee: decimalIntegerSchema(TRADE_MAX_AMOUNT, false),
  deadline: positiveSafeIntegerSchema, nonce: bytes32Schema,
}).strict().superRefine((intent, ctx) => {
  if ((intent.assetIn === zeroAddress) === (intent.assetOut === zeroAddress)
    || intent.assetIn === intent.sender || intent.assetOut === intent.sender) {
    ctx.addIssue({ code: 'custom', message: 'Expected a native/stock pair distinct from the sender' });
  }
  if (intent.recipient === intent.vault) ctx.addIssue({ code: 'custom', message: 'Recipient must not be the vault' });
  if (intent.amount.length <= 39 && intent.maxFee.length <= 39
    && /^(0|[1-9][0-9]*)$/.test(intent.amount) && /^(0|[1-9][0-9]*)$/.test(intent.maxFee)
    && BigInt(intent.maxFee) >= BigInt(intent.amount)) ctx.addIssue({ code: 'custom', message: 'maxFee must be less than amount' });
});

/** Returns a normalized copy. The pair, not a discovered route, is the authorization. */
export function validateTradeIntent(input: unknown): TradeIntent { return tradeSchema.parse(input); }

function canonicalJson(intent: TradeIntent): string { return JSON.stringify(intent, Object.keys(intent).sort()); }

export async function encryptTrade(intent: TradeIntent, publicKey: Hex): Promise<Hex> {
  const json = new TextEncoder().encode(canonicalJson(validateTradeIntent(intent)));
  const key = hexToBytes(bytes32Schema.parse(publicKey));
  if (json.length > TRADE_PLAINTEXT_BYTES - 2) throw new Error('Trade plaintext is too large');
  await sodium.ready;
  const plaintext = sodium.randombytes_buf(TRADE_PLAINTEXT_BYTES);
  try {
    new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).setUint16(0, json.length, false);
    plaintext.set(json, 2);
    return bytesToHex(sodium.crypto_box_seal(plaintext, key));
  } finally { sodium.memzero(plaintext); sodium.memzero(json); }
}

export async function decryptTrade(envelope: Hex, keys: EncryptionKeyPair): Promise<TradeIntent> {
  if (typeof envelope !== 'string' || !/^0x[0-9a-fA-F]+$/.test(envelope)
    || envelope.length !== 2 + TRADE_ENVELOPE_BYTES * 2) throw new Error('Invalid trade envelope length');
  const publicKey = hexToBytes(bytes32Schema.parse(keys.publicKey));
  const privateKey = hexToBytes(bytes32Schema.parse(keys.privateKey));
  await sodium.ready;
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = sodium.crypto_box_seal_open(hexToBytes(envelope), publicKey, privateKey);
    if (!plaintext || plaintext.length !== TRADE_PLAINTEXT_BYTES) throw new Error();
    const length = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint16(0, false);
    if (length === 0 || length > TRADE_PLAINTEXT_BYTES - 2) throw new Error();
    const json = new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(2, 2 + length));
    const intent = validateTradeIntent(JSON.parse(json));
    if (canonicalJson(intent) !== json) throw new Error();
    return intent;
  } catch { throw new Error('Invalid encrypted trade or encryption key'); }
  finally { if (plaintext) sodium.memzero(plaintext); sodium.memzero(privateKey); }
}

export interface TradeDepositBinding {
  sender: Address;
  vault: Address;
  chainId: number;
  asset: Address;
  amount: bigint;
}

const bindingSchema = z.object({
  sender: nonzeroAddressSchema, vault: nonzeroAddressSchema, chainId: positiveSafeIntegerSchema,
  asset: addressSchema, amount: z.bigint().positive().max(TRADE_MAX_AMOUNT),
}).strict();

/** Only trusted vault event fields may supply this binding, including the actual input asset. */
export function validateTradeDepositBinding(intent: TradeIntent, deposit: TradeDepositBinding): void {
  const validated = validateTradeIntent(intent);
  const binding = bindingSchema.parse(deposit);
  if (validated.sender !== binding.sender || validated.vault !== binding.vault || validated.chainId !== binding.chainId
    || validated.assetIn !== binding.asset || BigInt(validated.amount) !== binding.amount) {
    throw new Error('Trade does not match deposit sender, vault, chain, input asset, and amount');
  }
}

export interface BuildTradeDepositParams {
  chainId: number;
  vault: Address;
  sender: Address;
  assetIn: Address;
  assetOut: Address;
  amount: bigint;
  recipient?: Address;
  minAmountOut: bigint;
  maxFee: bigint;
  deadline: number;
  encryptionPublicKey: Hex;
}
export interface BuildTradeDepositResult { transaction: DepositTransaction; intent: TradeIntent }

const buildSchema = bindingSchema.omit({ asset: true }).extend({
  assetIn: addressSchema, assetOut: addressSchema, recipient: nonzeroAddressSchema.optional(),
  minAmountOut: z.bigint().positive().max(UINT128_MAX), maxFee: z.bigint().nonnegative().max(TRADE_MAX_AMOUNT),
  deadline: positiveSafeIntegerSchema, encryptionPublicKey: bytes32Schema,
}).strict();

/** Unsigned deposit only. ERC20 allowance checks/approvals belong to the caller's wallet. */
export async function buildTradeDepositTransaction(
  params: BuildTradeDepositParams, options: BuildDepositOptions = {},
): Promise<BuildTradeDepositResult> {
  const input = buildSchema.parse(params);
  const now = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .parse((options.now ?? (() => Math.floor(Date.now() / 1000)))());
  if (input.deadline <= now) throw new Error('Trade deadline must be in the future');
  await sodium.ready;
  const intent = validateTradeIntent({
    version: 2, chainId: input.chainId, vault: input.vault, sender: input.sender,
    assetIn: input.assetIn, assetOut: input.assetOut, amount: input.amount.toString(),
    recipient: input.recipient ?? input.sender, minAmountOut: input.minAmountOut.toString(),
    maxFee: input.maxFee.toString(), deadline: input.deadline, nonce: bytesToHex(sodium.randombytes_buf(32)),
  });
  const envelope = await encryptTrade(intent, input.encryptionPublicKey);
  const native = input.assetIn === zeroAddress;
  return {
    transaction: {
      to: input.vault, chainId: input.chainId, value: native ? input.amount : 0n,
      data: native ? encodeFunctionData({ abi: tradingVaultAbi, functionName: 'deposit', args: [envelope] })
        : encodeFunctionData({ abi: tradingVaultAbi, functionName: 'depositToken', args: [input.assetIn, input.amount, envelope] }),
    }, intent,
  };
}
