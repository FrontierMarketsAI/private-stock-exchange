import type { Address, Hex } from 'viem';
import type { PoolKey } from '../sdk/routes.js';

export interface TradeIntent {
  version: 2;
  chainId: number;
  vault: Address;
  sender: Address;
  assetIn: Address;
  assetOut: Address;
  amount: string;
  recipient: Address;
  minAmountOut: string;
  maxFee: string;
  deadline: number;
  nonce: Hex;
}

export interface TradeRoute {
  id: Hex;
  stock: Address;
  sell: boolean;
  wrapped: boolean;
  pools: PoolKey[];
  assetIn: Address;
  assetOut: Address;
}
