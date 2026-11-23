const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { finishDesktopCheck } = require('./desktop-dev-harness.cjs');
const { verifyDesktopCases } = require('./desktop-verification.cjs');

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

  let launches = 0;
  const receiptsDirectory = join(root, 'receipts');
  const options = {
    caseIds: ['example'], fingerprint: () => 'unchanged', receiptsDirectory,
    run: async inputsStillCurrent => {
      const report = { status: 'failed', assertionFailure };
      const reportPath = join(root, `launch-${++launches}.json`);
      await finishDesktopCheck(report, reportPath, async () => {}, inputsStillCurrent);
      return { report, reportPath };
    },
  };
  const original = await verifyDesktopCases(options);
  assert.equal(original.outcome, 'assertion_failed');
  assert.equal((await verifyDesktopCases(options)).outcome, 'blocked_same_failure');
  assert.equal(launches, 1);
  const replacement = JSON.parse(readFileSync(original.reportPath, 'utf8'));
  replacement.assertionFailure.assertion = 'another assertion';
  writeFileSync(original.reportPath, JSON.stringify(replacement));
  const rerun = await verifyDesktopCases(options);
  assert.equal(rerun.outcome, 'assertion_failed', 'a reused failure must link to the same report that the verifier checked');
  assert.equal(launches, 2);
  assert.notEqual(rerun.reportPath, original.reportPath);

  const [receipt] = readdirSync(receiptsDirectory);
  writeFileSync(join(receiptsDirectory, receipt), '{truncated');
  assert.equal((await verifyDesktopCases(options)).outcome, 'assertion_failed', 'an unreadable receipt must not block verification');
  assert.equal(launches, 3);
  console.log('PASS cached failures require an unchanged report and a readable receipt');

  let input = 'checked version';
  const changed = await verifyDesktopCases({
    ...options, fingerprint: () => input,
    run: async inputsStillCurrent => {
      const report = { status: 'passed' };
      const reportPath = join(root, 'changed-while-checking.json');
      await finishDesktopCheck(report, reportPath, async () => { input = 'different version'; }, inputsStillCurrent);
      return { report, reportPath };
    },
  });
  assert.equal(changed.outcome, 'inputs_changed', 'old input evidence must not be reported as passing');
  assert.equal(changed.verificationStatus, 'passed');
  const disk = JSON.parse(readFileSync(changed.reportPath, 'utf8'));
  assert.equal(disk.outcome, changed.outcome);
  assert.equal(disk.status, 'failed');
  console.log('PASS invalidated evidence preserves the check status and publishes the same outcome on disk');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
