import sodium from 'libsodium-wrappers';
import { bytesToHex, type Address, type Hex } from 'viem';

export interface EncryptionKeyPair { publicKey: Hex; privateKey: Hex }
export interface DepositTransaction { to: Address; data: Hex; value: bigint; chainId: number }
export interface BuildDepositOptions { now?: () => number }

/** Ephemeral fixtures and local cryptography only; never substitutes for the service's public key. */
export async function generateEncryptionKeyPair(): Promise<EncryptionKeyPair> {
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  try { return { publicKey: bytesToHex(keys.publicKey), privateKey: bytesToHex(keys.privateKey) }; }
  finally { sodium.memzero(keys.privateKey); }
}
