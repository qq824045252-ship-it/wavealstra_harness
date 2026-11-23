const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

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

function desktopVerificationOutcome({ verificationStatus, cleanupStatus, assertionFailure, inputStatus }) {
  if (cleanupStatus === 'failed' || inputStatus === 'unavailable' || (verificationStatus === 'failed' && !assertionFailure)) return 'infrastructure_failed';
  if (inputStatus === 'changed') return 'inputs_changed';
  return assertionFailure ? 'assertion_failed' : 'passed';
}

function readCacheFile(file) {
  try { return fs.readFileSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return undefined;
  }
}

function parseCache(bytes) {
  if (!bytes) return undefined;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
}

function completeAssertion(record) {
  return record?.outcome === 'assertion_failed' && record.verificationStatus === 'failed' && record.cleanupStatus === 'passed';
}

/** Only replay a completed assertion with the same inputs and its original report. */
async function verifyDesktopCases({ caseIds, fingerprint, receiptsDirectory, fresh = false, run }) {
  const input = fingerprint();
  const receiptPath = caseId => path.join(receiptsDirectory, `${digest(JSON.stringify([caseId, input]))}.json`);
  if (!fresh) {
    for (const caseId of caseIds) {
      const stored = parseCache(readCacheFile(receiptPath(caseId)));
      if (!completeAssertion(stored) || stored.assertionFailure?.caseId !== caseId
        || typeof stored.reportPath !== 'string' || !/^[a-f0-9]{64}$/.test(stored.reportSha256)) continue;
      const { reportSha256, ...receipt } = stored;
      const reportBytes = readCacheFile(receipt.reportPath);
      if (reportBytes && digest(reportBytes) === reportSha256) return { ...receipt, outcome: 'blocked_same_failure', reused: true };
    }
  }

  const inputsStillCurrent = () => fingerprint() === input;
  const { report, reportPath } = await run(inputsStillCurrent);
  const { assertionFailure, outcome, inputStatus, inputError } = report;
  if (!outcome) throw new Error('Verification report has no final outcome');
  const result = { outcome, reused: false, verificationStatus: report.verificationStatus,
    cleanupStatus: report.cleanupStatus, assertionFailure, reportPath,
    ...(inputStatus && { inputStatus }), ...(inputError && { inputError }) };
  if (inputStatus) return result;

  const passedCases = report.verificationStatus === 'passed' ? caseIds : (report.checks ?? [])
    .map(check => check.caseId).filter(caseId => caseIds.includes(caseId));
  for (const caseId of passedCases) fs.rmSync(receiptPath(caseId), { force: true });

  if (completeAssertion(result) && caseIds.includes(assertionFailure?.caseId)) {
    const reportBytes = readCacheFile(reportPath);
    const saved = parseCache(reportBytes);
    if (!completeAssertion(saved) || !isDeepStrictEqual(saved.assertionFailure, assertionFailure)) return result;
    const file = receiptPath(assertionFailure.caseId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.mkdirSync(receiptsDirectory, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ ...result, reportSha256: digest(reportBytes) }, null, 2));
    fs.renameSync(temporary, file);
  }
  return result;
}

module.exports = { assertDesktopCase, desktopVerificationOutcome, fingerprintFiles, verifyDesktopCases };
