import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = new URL('../dist/', import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
await build({ absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: 'dist/index.js',
  bundle: true, packages: 'external', format: 'esm', platform: 'neutral', target: 'es2022', sourcemap: false });
console.log('SDK build complete.');
