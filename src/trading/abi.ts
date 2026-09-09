import { parseAbi } from 'viem';

/** Only the two unsigned funding calls are needed by the SDK. */
export const tradingVaultAbi = parseAbi([
  'function deposit(bytes envelope) payable',
  'function depositToken(address asset, uint256 amount, bytes envelope)',
]);
