import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';

const response = await fetch('https://priv.frontiermarkets.ai/openapi.json', { redirect: 'error', signal: AbortSignal.timeout(30_000) });
assert.equal(response.status, 200);
const document = await response.json();
assert.equal(document.openapi, '3.1.0');
assert.deepEqual(Object.keys(document.paths).sort(), ['/api/v1/assets', '/api/v1/config', '/api/v1/orders/status', '/api/v1/quote']);
await SwaggerParser.validate(structuredClone(document), { resolve: { external: false } });
await writeFile(new URL('../docs/openapi.json', import.meta.url), JSON.stringify(document, null, 2) + '\n');
console.log('Updated the public OpenAPI snapshot. Review its diff before committing.');
