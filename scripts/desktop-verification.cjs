const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprintFiles(root, files, environment) {
  const inputs = [...files].sort().map(file => [file, digest(fs.readFileSync(path.join(root, file)))]);
  return digest(JSON.stringify({ inputs, environment }));
}

function assertDesktopCase(report, caseId, assertion, condition, evidence) {
  if (condition) return;
  report.assertionFailure = { caseId, assertion, ...evidence };
  throw new Error(`${caseId}: ${assertion}`);
}

/** Only replay a completed assertion with the same inputs and its original report. */
async function verifyDesktopCases({ caseIds, fingerprint, receiptsDirectory, fresh = false, run }) {
  const input = fingerprint();
  const receiptPath = caseId => path.join(receiptsDirectory, `${digest(JSON.stringify([caseId, input]))}.json`);
  if (!fresh) {
    for (const caseId of caseIds) {
      const file = receiptPath(caseId);
      if (!fs.existsSync(file)) continue;
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (fs.existsSync(receipt.reportPath)) return { ...receipt, outcome: 'blocked_same_failure', reused: true };
    }
  }

  const { report, reportPath } = await run();
  const assertionFailure = report.assertionFailure;
  const infrastructureFailed = report.cleanupStatus === 'failed' || (report.verificationStatus === 'failed' && !assertionFailure);
  const outcome = infrastructureFailed ? 'infrastructure_failed' : assertionFailure ? 'assertion_failed' : 'passed';
  const result = { outcome, reused: false, verificationStatus: report.verificationStatus,
    cleanupStatus: report.cleanupStatus, assertionFailure, reportPath };
  if (fingerprint() !== input) return result;

  const passedCases = report.verificationStatus === 'passed' ? caseIds : (report.checks ?? [])
    .map(check => check.caseId).filter(caseId => caseIds.includes(caseId));
  for (const caseId of passedCases) fs.rmSync(receiptPath(caseId), { force: true });

  if (outcome === 'assertion_failed' && caseIds.includes(assertionFailure.caseId)) {
    const file = receiptPath(assertionFailure.caseId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(receiptsDirectory, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2));
    fs.renameSync(temporary, file);
  }
  return result;
}

module.exports = { assertDesktopCase, fingerprintFiles, verifyDesktopCases };
