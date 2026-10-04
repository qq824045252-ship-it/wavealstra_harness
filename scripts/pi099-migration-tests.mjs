import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync(resolve('out/tests'), { recursive: true });
const output = resolve('out/tests/pi099-migration-integration.mjs');
await build({ entryPoints: [resolve('scripts/pi099-migration-integration.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22',
  alias: { electron: resolve('scripts/pi099-electron-stub.ts') }, logLevel: 'warning' });
const code = await new Promise((done, fail) => {
  const child = spawn(process.execPath, [output], { stdio: 'inherit', windowsHide: true });
  child.once('error', fail); child.once('exit', (code, signal) => done(signal ? 1 : code ?? 1));
});
process.exitCode = code;
