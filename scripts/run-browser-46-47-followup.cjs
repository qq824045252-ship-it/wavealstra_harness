const { build } = require('esbuild');
const { mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
(async () => {
  mkdirSync('out/tests', { recursive: true });
  for (const [entry, output, platform, format, external] of [
    ['browser-controlled-form-fixture.tsx', 'browser-controlled-form-fixture.js', 'browser', 'iife', false],
    ['browser-46-47-followup.ts', 'browser-46-47-followup.cjs', 'node', 'cjs', false],
    ['browser-stop-native.ts', 'browser-stop-native.mjs', 'node', 'esm', true],
  ]) {
    const result = await build({ entryPoints: [`scripts/${entry}`], bundle: true, platform, format,
      external: ['electron'], ...(external ? { packages: 'external' } : {}), write: false });
    writeFileSync(`out/tests/${output}`, result.outputFiles[0].contents);
  }
  for (const file of ['browser-46-47-followup.cjs', 'browser-stop-native.mjs']) {
    const result = spawnSync(require('electron'), [`out/tests/${file}`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'inherit', timeout: 120000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`${file} failed (${result.status})`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
