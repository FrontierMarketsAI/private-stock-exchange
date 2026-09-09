import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { FrontierApiError, FrontierClient, validateTradeIntent } from '../src/client/index.js';

async function main(): Promise<void> {
  const { FRONTIER_API_KEY, FRONTIER_BASE_URL, PRIVATE_ORDER_FILE, DEPOSIT_HASH } = process.env;
  if (!FRONTIER_API_KEY || !PRIVATE_ORDER_FILE) {
    console.error('Set FRONTIER_API_KEY and PRIVATE_ORDER_FILE. Supply DEPOSIT_HASH only after your own wallet broadcasts the saved deposit.');
    process.exitCode = 1;
    return;
  }
  const filename = resolve(PRIVATE_ORDER_FILE);
  const directory = dirname(filename);
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!isAbsolute(PRIVATE_ORDER_FILE) || filename !== PRIVATE_ORDER_FILE || await realpath(directory) !== directory
    || filename.split(sep).some((part) => ['web', 'public', 'www', 'html', 'htdocs', 'dist'].includes(part.toLowerCase()))) throw new Error();
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
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bundle: { version?: unknown; intent?: unknown; depositHash?: unknown };
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== owner || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 || info.size > 65_536) throw new Error();
    const buffer = Buffer.alloc(65_537);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > 65_536) throw new Error();
    bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))) as typeof bundle;
  } finally { await file.close(); }
  if (!bundle || bundle.version !== 1) throw new Error();
  const intent = validateTradeIntent(bundle.intent);
  if (DEPOSIT_HASH !== undefined && bundle.depositHash !== undefined
    && (typeof bundle.depositHash !== 'string' || DEPOSIT_HASH.toLowerCase() !== bundle.depositHash.toLowerCase())) throw new Error();
  const depositHash = DEPOSIT_HASH ?? bundle.depositHash;
  if (typeof depositHash !== 'string') {
    console.error('No deposit hash recorded. After your wallet broadcasts, supply DEPOSIT_HASH or privately record depositHash in this bundle. This example never funds.');
    process.exitCode = 1;
    return;
  }
  const client = new FrontierClient({ apiKey: FRONTIER_API_KEY,
    ...(FRONTIER_BASE_URL === undefined ? {} : { baseUrl: FRONTIER_BASE_URL }) });
  const result = await client.getOrderStatus({ depositHash: depositHash as Hex, nonce: intent.nonce });
  // Do not print the bundle, nonce, recipient, or deposit-to-payout relationship.
  console.log('Order status:', result.status);
  if (result.status === 'confirming') console.log('Privacy-preserving result, not proof that funding failed. Preserve this order and check the original wallet transaction.');
  if (result.status === 'attention') {
    console.error('Stop and seek operator help through a private support channel. Do not submit a replacement deposit.');
    process.exitCode = 1;
  }
  if (result.status === 'completed' || result.status === 'refunded') console.log('Verified mined L2 outcome, not irreversible Ethereum finality.');
  if (result.status === 'processing') console.log('Processing is unresolved. Wait and check this same order later; do not create another deposit.');
}

void main().catch((error: unknown) => {
  if (error instanceof FrontierApiError) console.error('Frontier API error:', error.code, error.status ?? 'no HTTP status');
  else console.error('Status check failed. Privately check the protected bundle, permissions, API settings, and original deposit hash.');
  console.error('Preserve the same order. A failed status request is not permission to fund again.');
  process.exitCode = 1;
});
