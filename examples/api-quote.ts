import { FrontierApiError, FrontierClient, type TradingQuoteRequest } from '../src/client/index.js';

async function main(): Promise<void> {
  const { FRONTIER_API_KEY, FRONTIER_BASE_URL, STOCK_ADDRESS, SIDE, AMOUNT_RAW } = process.env;
  if (!FRONTIER_API_KEY || !STOCK_ADDRESS || !AMOUNT_RAW || (SIDE !== 'buy' && SIDE !== 'sell')) {
    console.error('Set FRONTIER_API_KEY, STOCK_ADDRESS, SIDE=buy|sell, and AMOUNT_RAW. No wallet key is needed.');
    process.exitCode = 1;
    return;
  }
  const client = new FrontierClient({ apiKey: FRONTIER_API_KEY,
    ...(FRONTIER_BASE_URL === undefined ? {} : { baseUrl: FRONTIER_BASE_URL }) });
  const request: TradingQuoteRequest = {
    // Type assertions do not validate input; client.quote performs runtime SDK validation.
    stock: STOCK_ADDRESS as TradingQuoteRequest['stock'], side: SIDE,
    amount: AMOUNT_RAW, slippageBps: Number(process.env.SLIPPAGE_BPS ?? '50'),
  };
  const config = await client.getConfig();
  const quote = await client.quote(request);
  console.log(JSON.stringify({ acceptingOrders: config.acceptingOrders, side: quote.side,
    amountIn: quote.amountIn, amountOut: quote.amountOut, minAmountOut: quote.minAmountOut,
    feeAmount: quote.feeAmount, poolFees: quote.poolFees, expiresAt: quote.expiresAt }, null, 2));
  console.log('Quote only. No approval, signing, funding, or liquidity reservation occurred.');
}

void main().catch((error: unknown) => {
  if (error instanceof FrontierApiError) console.error('Frontier API error:', error.code, error.status ?? 'no HTTP status');
  else console.error('Quote example failed. Check configuration privately; no funds were sent.');
  process.exitCode = 1;
});
