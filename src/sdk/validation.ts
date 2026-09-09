import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { z } from 'zod';

export const UINT128_MAX = (1n << 128n) - 1n;
export const UINT256_MAX = (1n << 256n) - 1n;

export const addressSchema = z.string()
  .refine((value) => isAddress(value, { strict: true }), 'Invalid address or checksum')
  .transform((value) => getAddress(value) as Address);

export const nonzeroAddressSchema = addressSchema.refine(
  (value) => value !== zeroAddress,
  'Address must not be zero',
);

export const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const bytes32Schema = z.string().length(66).regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);

export function decimalIntegerSchema(max: bigint, positive: boolean) {
  const maxLength = max.toString().length;
  return z.string().max(maxLength).regex(/^(0|[1-9][0-9]*)$/)
    .refine((value) => {
      if (value.length > maxLength || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
      const integer = BigInt(value);
      return integer.toString() === value && integer <= max && (!positive || integer > 0n);
    }, 'Integer out of range');
}
