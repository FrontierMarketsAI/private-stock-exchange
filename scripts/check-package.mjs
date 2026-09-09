import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';

const [manifest] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
for (const { path } of manifest.files) {
  assert.ok(['package.json', 'README.md', 'SECURITY.md', 'dist/index.js'].includes(path)
    || /^dist\/types\/[a-z/-]+\.d\.ts$/.test(path), `Unexpected package file: ${path}`);
  assert.ok(!/server|operator|\.map$|\.env|\.key$/.test(path), `Private/server artifact in package: ${path}`);
}
assert.ok(manifest.files.some(({ path }) => path === 'dist/index.js'));
assert.ok(manifest.files.some(({ path }) => path === 'dist/types/client/index.d.ts'));
const sdk = await import('../dist/index.js');
assert.equal(typeof sdk.FrontierClient, 'function');
assert.equal(typeof sdk.buildTradeDepositTransaction, 'function');
const spec = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
await SwaggerParser.validate(spec, { resolve: { external: false } });
console.log(`Package allowlist verified (${manifest.files.length} files); SDK imports and OpenAPI validation passed.`);
