const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { finishDesktopCheck } = require('./desktop-dev-harness.cjs');

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-check-result-'));
  for (const status of ['passed', 'failed']) {
    for (const cleanupFails of [false, true]) {
      const file = join(root, `${status}-${cleanupFails}.json`);
      const report = { status, ...(status === 'failed' ? { error: 'Title assertion failed' } : {}) };
      const gate = Promise.withResolvers();
      const read = () => JSON.parse(readFileSync(file, 'utf8'));
      const finished = finishDesktopCheck(report, file, async () => {
        await gate.promise;
        if (cleanupFails) throw new Error('Isolated launcher did not exit');
      });
      assert.deepEqual(read(), { status: 'running', ...(status === 'failed' ? { error: 'Title assertion failed' } : {}),
        verificationStatus: status, cleanupStatus: 'running' });
      gate.resolve();
      await finished;
      assert.deepEqual(read(), {
        status: cleanupFails ? 'failed' : status,
        ...(status === 'failed' ? { error: 'Title assertion failed' } : {}),
        verificationStatus: status, cleanupStatus: cleanupFails ? 'failed' : 'passed',
        ...(cleanupFails ? { cleanupError: 'Error: Isolated launcher did not exit' } : {}),
      });
    }
  }
  console.log('PASS a check result is readable while cleanup waits, and failures in each stage remain distinguishable');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
