const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { finishDesktopCheck } = require('./desktop-dev-harness.cjs');
const { verifyDesktopCases } = require('./desktop-verification.cjs');
const { fingerprintTitleInputs, verifyLayout } = require('./desktop-task-title-test.cjs');

async function checkTitleVerification(root) {
  const testCase = { id: 'long-title', overview: false, title: 'The long task title', width: 1440 };
  const geometry = { headerWidth: 1440, available: 700, actual: 1, needed: 1600, clipped: true, ellipsis: true,
    text: testCase.title, tooltip: testCase.title,
    controls: ['历史提问', '执行诊断', '打开概览'].map(name => ({ name, clickable: true, withinHeader: true })) };
  const report = { checks: [] };
  const context = {
    report,
    rpc: async () => {},
    until: async () => {},
    evaluate: async expression => {
      if (expression.includes('requestAnimationFrame')) throw new Error('CDP timeout: Runtime.evaluate');
      if (expression.includes('function measureHeader')) return geometry;
      if (expression.includes('const rect = (')) return { x: 1, y: 1 };
      if (expression.includes('activeTaskId')) return 'task';
      return false;
    },
  };
  await assert.rejects(verifyLayout([testCase], context), /title-fits-remaining-width/);
  assert.equal(report.assertionFailure.observed.actual, 1);
  assert.equal(report.checks.length, 0);
  delete report.assertionFailure;
  geometry.actual = 700;
  await verifyLayout([testCase], context);
  assert.equal(report.checks.length, 1);

  const file = 'src/renderer/src/store/app/commands/taskLifecycle.ts';
  mkdirSync(join(root, 'patches'));
  for (const relative of [
    'scripts/desktop-task-title-test.cjs', 'scripts/desktop-dev-harness.cjs', 'scripts/desktop-verification.cjs',
    'electron.vite.config.ts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', file,
  ]) {
    const dest = join(root, relative);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, 'original');
  }
  const original = fingerprintTitleInputs(root, {});
  writeFileSync(join(root, file), 'changed');
  assert.notEqual(fingerprintTitleInputs(root, {}), original);
  console.log('PASS title verification rejects unused width and fingerprints the tested rename action');
}

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
      const reportSha256 = await finishDesktopCheck(report, reportPath, async () => {}, inputsStillCurrent);
      return { report, reportPath, reportSha256 };
    },
  };
  const original = await verifyDesktopCases(options);
  assert.equal(original.outcome, 'assertion_failed');
  assert.equal(original.inputFingerprint, 'unchanged');
  assert.deepEqual(original.caseIds, ['example']);
  assert.equal(original.reportSha256, createHash('sha256').update(readFileSync(original.reportPath)).digest('hex'));
  assert.equal((await verifyDesktopCases(options)).outcome, 'blocked_same_failure');
  const [cacheEntry] = readdirSync(receiptsDirectory);
  const cachePath = join(receiptsDirectory, cacheEntry);
  const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  writeFileSync(cachePath, JSON.stringify({ ...cached, assertionFailure: { ...assertionFailure, assertion: 'copied summary disagrees' } }));
  const replayed = await verifyDesktopCases(options);
  assert.equal(replayed.outcome, 'blocked_same_failure');
  assert.deepEqual(replayed.assertionFailure, original.assertionFailure, 'replay must use the verified report to describe the failure');
  assert.equal(replayed.reportSha256, original.reportSha256);
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
      const reportSha256 = await finishDesktopCheck(report, reportPath, async () => { input = 'different version'; }, inputsStillCurrent);
      return { report, reportPath, reportSha256 };
    },
  });
  assert.equal(changed.outcome, 'inputs_changed', 'old input evidence must not be reported as passing');
  assert.equal(changed.verificationStatus, 'passed');
  const disk = JSON.parse(readFileSync(changed.reportPath, 'utf8'));
  assert.equal(disk.outcome, changed.outcome);
  assert.equal(disk.status, 'failed');
  console.log('PASS invalidated evidence preserves the check status and publishes the same outcome on disk');
  const competing = await verifyDesktopCases({ ...options, fresh: true, run: async inputsStillCurrent => {
    const run = await options.run(inputsStillCurrent);
    writeFileSync(run.reportPath, JSON.stringify({ ...run.report, outcome: 'passed' }));
    return run;
  } });
  assert.equal(competing.outcome, 'infrastructure_failed', 'a replaced report cannot take over the finished run');
  assert.equal(competing.reportSha256, undefined);
  await checkTitleVerification(root);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
