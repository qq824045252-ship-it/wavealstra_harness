/** Offline verification of unchanged real transport/history records. Does not turn a failed live command into a pass. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const quote = 'I26_EXACT_ORIGINAL: At 03:17 UTC the brass key NB-7/4412 passed the north observatory.';
function inspectTranslation(answer) {
  // Meaning, not one Chinese synonym: tomorrow may be 明天 or 明日.
  assert(answer.includes('C-26') && answer.includes('校准') && /明[天日]/u.test(answer)
    && /(?:十|10)(?:点|时)|10:00/u.test(answer), 'translation must preserve calibration, C-26, tomorrow and ten');
  return { bay: 'C-26', day: 'tomorrow', hour: 10 };
}
function inspectPortCorrection(answer) {
  const assignments = [...answer.matchAll(/\bconst\s+PORT\s*=\s*(\d+)\s*;?/g)];
  assert(assignments.length > 0 && assignments.every(match => match[1] === '6284'), 'every actual PORT declaration must use the corrected value 6284');
  return { currentPort: 6284, outputOnlyRequestedConstant: /^(?:```(?:js|javascript)?\s*)?const\s+PORT\s*=\s*6284\s*;?\s*(?:```)?$/.test(answer.trim()) };
}
function assess(report, requests) {
  const result = label => {
    const rows = report.cases.filter(item => item.label === label && typeof item.answer === 'string');
    assert.equal(rows.length, 1, 'one completed real answer for ' + label);
    if (rows[0].durableOutcome !== undefined) assert.equal(rows[0].durableOutcome, 'completed');
    return rows[0];
  };
  const log = result('log diagnosis'); assert(log.answer.includes('E26_PATH_MISSING') && log.answer.includes('/tmp/context26/calibration.toml'));
  assert(result('inventory arithmetic').answer.includes('38'));
  const translation = result('translation'); inspectTranslation(translation.answer);
  const extracted = result('structured extraction').answer; assert(extracted.includes('AX26') && extracted.includes('14') && extracted.includes('Lin'));
  const port = inspectPortCorrection(result('instruction correction').answer);
  const original = result('verbatim retrieval after restart'); assert(original.answer.includes('NB-7/4412') && original.answer.includes('03:17 UTC'));
  const originalEvidence = requests.slice(original.requestStart, original.requestEnd).flatMap((request, offset) => request.messages.filter(message => message.role === 'tool' && JSON.stringify(message.content).includes('source: original Durable entries') && JSON.stringify(message.content).includes(quote)).map(message => ({ requestIndex: original.requestStart + offset, text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) })));
  assert(originalEvidence.length, 'exact original must reach the real provider as a tool result');
  const bot = result('Bot foreground context-tool access');
  assert(requests.slice(bot.requestStart, bot.requestEnd).some(request => request.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('engine: billion-context'))));
  const summaryRequests = requests.flatMap((request, index) => request.messages.some(message => ['system', 'developer'].includes(message.role) && JSON.stringify(message.content).includes('You compress conversation history')) ? [{ index, model: request.model, requestCharacters: JSON.stringify(request.messages).length }] : []);
  const projectedRequests = requests.flatMap((request, index) => request.messages.some(message => JSON.stringify(message.content).includes('[Compressed conversation section]')) ? [index] : []);
  assert(summaryRequests.length > 0); assert(projectedRequests.length > 0);
  assert(projectedRequests.some(index => index >= original.requestStart), 'committed projection survives the cold restart');
  return { assessment: 'seven functional behaviors verified against recorded real data', liveCommandStatus: report.status, liveCommandError: report.error, source: report.source, model: report.modelConfiguration, requestCount: requests.length,
    cases: report.cases.filter(item => typeof item.answer === 'string'), correction: port,
    strictFormatting: port.outputOnlyRequestedConstant ? 'passed' : 'deviation: correct constant followed by an extra explanation that the old port is deprecated',
    summaryRequests, projectedRequests, originalEvidence: originalEvidence.map(item => ({ requestIndex: item.requestIndex, exactQuote: quote, resultSha256: crypto.createHash('sha256').update(item.text).digest('hex') })),
    beforeRestart: report.beforeRestart, afterRestart: report.afterRestart,
    usage: { pricing: 'not measured', requests: (report.usage?.raw ?? []).map(item => ({ requestIndex: item.requestIndex, usage: item.usage })) },
    limitations: ['Recorded-data revalidation is not a new live run and does not erase its original command failure.', 'No physical desktop input, packaging, full headless aggregate, cost comparison, or real 100K-entry cold-store acceptance is claimed.'] };
}
exports.inspectTranslation = inspectTranslation;
exports.inspectPortCorrection = inspectPortCorrection;
exports.assess = assess;
if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    for (const answer of ['校准团队将于明天十点检查 C-26 区域。', '校准团队将于明日十点检查 C-26 区域。', '校准团队明日10:00检查C-26。']) assert.equal(inspectTranslation(answer).hour, 10);
    for (const answer of ['校准团队将于昨日十点检查 C-26。', '校准团队明日十一点检查C-26。', '校准团队明日十点检查C-27。']) assert.throws(() => inspectTranslation(answer));
    assert.equal(inspectPortCorrection('const PORT = 6284;').outputOnlyRequestedConstant, true);
    assert.equal(inspectPortCorrection('```js\nconst PORT = 6284;\n```').outputOnlyRequestedConstant, true);
    assert.equal(inspectPortCorrection('const PORT = 6284;\n6173 已废弃。').outputOnlyRequestedConstant, false);
    assert.throws(() => inspectPortCorrection('const PORT = 6173; // use 6284 later'));
    assert.throws(() => inspectPortCorrection('const PORT = 6284; const PORT = 6173;'));
    assert.throws(() => inspectPortCorrection('6284'));
    console.log('PASS translation meaning including 明日/明天 and wrong-day/time/bay rejection; corrected PORT value, rejection of stale/conflicting assignments, and separate strict-format observation');
  } else {
    const [directory, output] = process.argv.slice(2);
    if (!directory || !output) throw Error('usage: node scripts/durable-context-live-assessment.cjs <recorded-run-directory> <assessment.json>');
    const reportPath = path.join(directory, 'report.json'), requestsPath = path.join(directory, 'provider-requests.json');
    const assessment = assess(JSON.parse(fs.readFileSync(reportPath)), JSON.parse(fs.readFileSync(requestsPath)));
    assessment.rawEvidenceHashes = Object.fromEntries([reportPath, requestsPath].map(file => [path.basename(file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(assessment, null, 2) + '\n');
    console.log(assessment.assessment + '; original command=' + assessment.liveCommandStatus + '; strict formatting=' + assessment.strictFormatting);
  }
}
