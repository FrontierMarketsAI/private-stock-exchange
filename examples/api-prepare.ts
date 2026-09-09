import { lstat, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, erc20Abi, getAddress, http, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { FrontierApiError, FrontierClient, type TradingQuoteRequest } from '../src/client/index.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const { FRONTIER_API_KEY, FRONTIER_BASE_URL, STOCK_ADDRESS, SIDE, AMOUNT_RAW, SENDER,
    RECIPIENT, EXPECTED_VAULT, EXPECTED_ENCRYPTION_PUBLIC_KEY, PRIVATE_ORDER_FILE, RPC_URL } = process.env;
  if (!FRONTIER_API_KEY || !STOCK_ADDRESS || !AMOUNT_RAW || !SENDER || !EXPECTED_VAULT
    || !EXPECTED_ENCRYPTION_PUBLIC_KEY || !PRIVATE_ORDER_FILE || (SIDE !== 'buy' && SIDE !== 'sell')) {
    console.error('Set API key, stock, SIDE=buy|sell, AMOUNT_RAW, SENDER, both deployment pins, and PRIVATE_ORDER_FILE. See README.md#runnable-examples.');
    process.exitCode = 1;
    return;
  }

  // Refuse defaults, symlinked parents, web folders, and all paths inside the checkout.
  const filename = resolve(PRIVATE_ORDER_FILE);
  const directory = dirname(filename);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!isAbsolute(PRIVATE_ORDER_FILE) || filename !== PRIVATE_ORDER_FILE || await realpath(directory) !== directory
    || filename.split(sep).some((part) => ['web', 'public', 'www', 'html', 'htdocs', 'dist'].includes(part.toLowerCase()))) {
    throw new Error();
  }
  for (const root of [project, await realpath(process.cwd())]) {
    if (filename === root || filename.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error();
  }
  const owner = process.getuid?.();
  const parentInfo = await stat(directory);
  if (owner === undefined || parentInfo.uid !== owner || (parentInfo.mode & 0o7777) !== 0o700) throw new Error();
  for (let parent = directory; ; parent = dirname(parent)) {
    const info = await stat(parent);
    const stickyRoot = parent !== directory && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || info.uid !== 0 && info.uid !== owner || (info.mode & 0o022) !== 0 && !stickyRoot) throw new Error();
    if (dirname(parent) === parent) break;
  }
  try {
    await lstat(filename);
    console.error('Output already exists. Preserve the existing order; do not prepare a replacement for an uncertain deposit.');
    process.exitCode = 1;
    return;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw new Error();
  }

  const client = new FrontierClient({ apiKey: FRONTIER_API_KEY,
    ...(FRONTIER_BASE_URL === undefined ? {} : { baseUrl: FRONTIER_BASE_URL }),
    expectedVault: EXPECTED_VAULT as Address, expectedEncryptionPublicKey: EXPECTED_ENCRYPTION_PUBLIC_KEY as Hex });
  const request: TradingQuoteRequest = { stock: STOCK_ADDRESS as Address, side: SIDE,
    amount: AMOUNT_RAW, slippageBps: Number(process.env.SLIPPAGE_BPS ?? '50') };
  // Validate the public sender before the read-only allowance RPC; prepareTrade also validates addresses.
  if (!isAddress(SENDER, { strict: true }) || getAddress(SENDER) === zeroAddress) throw new FrontierApiError('INVALID_REQUEST');
  const sender = getAddress(SENDER);
  let quote = await client.quote(request);
  if (SIDE === 'sell') {
    if (!RPC_URL || new URL(RPC_URL).protocol !== 'https:') {
      console.error('Sells require a trusted HTTPS RPC_URL for a read-only chain and allowance check.');
      process.exitCode = 1;
      return;
    }
    const config = await client.getConfig();
    if (!config.vault) throw new FrontierApiError('NOT_READY');
    const rpc = createPublicClient({ transport: http(RPC_URL, { retryCount: 0 }) });
    if (await rpc.getChainId() !== config.chainId) throw new Error();
    const allowance = await rpc.readContract({ address: quote.stock, abi: erc20Abi,
      functionName: 'allowance', args: [sender, config.vault] });
    if (allowance < BigInt(AMOUNT_RAW)) {
      console.error('Insufficient allowance. In your wallet, separately approve the pinned vault for exactly AMOUNT_RAW of STOCK_ADDRESS.');
      console.error('Verify the successful approval receipt and allowance on chain 4663, then rerun for a fresh quote. Nothing was prepared or sent.');
      process.exitCode = 1;
      return;
    }
    // Approval/check latency must not turn an old quote into a funding decision.
    quote = await client.quote(request);
  }
  const prepared = await client.prepareTrade({ request, quote, sender,
    ...(RECIPIENT === undefined ? {} : { recipient: RECIPIENT as Address }) });

  // transaction.data contains the ciphertext. intent contains its private plaintext and status nonce.
  // Never persist the API key. Never overwrite an earlier order, even after a partial write.
  const file = await open(filename, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify({ version: 1, request, quote, ...prepared },
      (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  console.log('Sensitive order bundle saved privately. No approval, signature, or broadcast occurred.');
  console.log('Review the saved quote and transaction in a trusted wallet, simulate, and explicitly consent before any funding.');
  console.log('After broadcasting, retain the actual deposit hash with this same bundle. Never automatically create another deposit after uncertainty.');
}

void main().catch((error: unknown) => {
  if (error instanceof FrontierApiError) console.error('Frontier API error:', error.code, error.status ?? 'no HTTP status');
  else console.error('Preparation failed. Check settings, trusted RPC, and the new absolute private path (0700 directory, outside checkout/web).');
  console.error('No funds were sent by this example. Preserve any existing or partial bundle; do not fund unless it was saved successfully.');
  process.exitCode = 1;
});
