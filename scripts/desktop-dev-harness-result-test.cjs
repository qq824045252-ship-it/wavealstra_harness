const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { finishDesktopCheck } = require('./desktop-dev-harness.cjs');

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-check-result-'));
  const assertionFailure = { caseId: 'example', assertion: 'visible' };
  const scenarios = [
    [{ status: 'passed' }, true, 'infrastructure_failed'],
    [{ status: 'passed' }, false, 'passed'],
    [{ status: 'failed', error: 'Renderer unavailable' }, false, 'infrastructure_failed'],
    [{ status: 'failed', error: 'Renderer unavailable' }, true, 'infrastructure_failed'],
    [{ status: 'failed', assertionFailure }, false, 'assertion_failed'],
    [{ status: 'failed', assertionFailure }, true, 'infrastructure_failed'],
  ];
  for (const [index, [initialReport, cleanupFails, outcome]] of scenarios.entries()) {
    const file = join(root, `${index}.json`);
    const report = { ...initialReport };
    const gate = Promise.withResolvers();
    const read = () => JSON.parse(readFileSync(file, 'utf8'));
    const finished = finishDesktopCheck(report, file, async () => {
      await gate.promise;
      if (cleanupFails) throw new Error('Isolated launcher did not exit');
    });
    assert.deepEqual(read(), { ...initialReport, status: 'running', verificationStatus: initialReport.status, cleanupStatus: 'running' });
    gate.resolve();
    await finished;
    assert.deepEqual(read(), {
      ...initialReport,
      status: cleanupFails ? 'failed' : initialReport.status,
      verificationStatus: initialReport.status, cleanupStatus: cleanupFails ? 'failed' : 'passed', outcome,
      ...(cleanupFails ? { cleanupError: 'Error: Isolated launcher did not exit' } : {}),
    });
  }
  console.log('PASS only final reports contain the overall outcome and both diagnostic stages');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
