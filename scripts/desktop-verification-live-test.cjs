/** Real gateway model through the ordinary MyBuddy Electron task path. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parseArgs } = require('node:util');
const { run } = require('./desktop-dev-harness.cjs');

const { values } = parseArgs({ options: { case: { type: 'string' } } });
if (values.case && !['audit', 'recovery'].includes(values.case)) throw new Error('Expected --case=audit or --case=recovery');
const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
const node = quote(process.execPath);
const modelText = message => message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');

async function readTurn(home, taskId, receipt, until) {
  const digest = createHash('sha256').update(taskId).digest('hex');
  const file = path.join(home, '.mybuddy', 'durable', digest, 'durable.sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const findSubmission = db.prepare('SELECT conversation_id, status, record FROM submissions WHERE id=?');
    let submission;
    await until(() => {
      submission = findSubmission.get(receipt.submissionId);
      return submission?.status === 'done' || submission?.status === 'unanswered';
    }, `native settlement ${receipt.operationId}`);
    assert(submission, `Missing native submission ${receipt.operationId}`);
    const { entry, answer } = JSON.parse(submission.record);
    assert.equal(submission.status, 'done');
    assert(Number.isSafeInteger(Number(entry)) && Number.isSafeInteger(Number(answer)) && Number(answer) >= Number(entry));
    const messages = db.prepare(`SELECT m.value FROM entries e, json_each(e.record, '$.model') m
      WHERE e.conversation_id=? AND e.id>=? AND e.id<=? ORDER BY e.id, m.key`)
      .all(submission.conversation_id, Number(entry), Number(answer)).map(row => JSON.parse(row.value));
    const final = messages.findLast(message => message.role === 'assistant');
    assert.equal(final?.stopReason, 'stop');
    const reply = modelText(final).trim();
    assert(reply, 'Expected a final text answer after the actual tool calls');
    return { messages, reply };
  } finally { db.close(); }
}

function evidence({ messages, reply }) {
  const tools = messages.flatMap((message, index) => message.role === 'assistant' ? message.content
    .filter(part => part.type === 'toolCall').map(part => ({ index, name: part.name, arguments: part.arguments })) : []);
  const verification = messages.flatMap((message, index) => {
    if (message.role !== 'toolResult') return [];
    return modelText(message).split('\n').filter(line => line.startsWith('VERIFICATION_RESULT '))
      .map(line => ({ index, isError: message.isError, ...JSON.parse(line.slice('VERIFICATION_RESULT '.length)) }));
  });
  return { reply, tools, verification };
}

run(async ({ evaluate, until, home, report, requests }) => {
  function prepare(id) {
    const folder = path.join(home, id);
    fs.mkdirSync(folder);
    for (const file of ['desktop-dev-harness.cjs', 'desktop-verification.cjs', 'desktop-verification-case-fixture.cjs']) {
      fs.copyFileSync(path.join(__dirname, file), path.join(folder, file));
    }
    fs.writeFileSync(path.join(folder, 'fixture-layout.txt'), 'broken\n');
    return folder;
  }
  const api = (method, ...args) => evaluate(`window.api.${method}(${args.map(arg => JSON.stringify(arg)).join(',')})`);
  const modelId = `fixture/${report.modelConfiguration.modelId}`;
  async function register(id, cwd) {
    const spaceId = `space-${id}`;
    await api('db.upsertSpace', { id: spaceId, name: id, path: cwd });
    await api('db.upsertTask', { id, title: '桌面验收样例', spaceId, cwd, welcomeMode: 'working',
      executionBackend: 'pi', permissionMode: 'auto', modelId, updatedAt: Date.now() });
  }
  async function prompt(taskId, operationId, text) {
    const request = { taskId, spaceId: `space-${taskId}`, modelId, text, userMessageId: operationId,
      assistantMessageId: `${operationId}-reply`, welcomeMode: 'working', permissionMode: 'auto' };
    const admitted = await api('agent.prompt', request);
    assert(admitted.receipt, JSON.stringify(admitted));
    assert.equal(admitted.receipt.operationId, operationId);
    return evidence(await readTurn(home, taskId, admitted.receipt, until));
  }
  const verificationCommand = `${node} desktop-verification-case-fixture.cjs`;
  const launchCount = folder => fs.readFileSync(path.join(folder, 'launches.txt'), 'utf8').trim().split('\n').length;

  if (values.case !== 'recovery') {
    const auditId = 'verification-audit-live';
    const audit = prepare(auditId);
    await register(auditId, audit);
    report.audit = await prompt(auditId, 'audit-live-1', `在本任务工作区复核聊天标题验收，当前阶段只验收，不修改工作区。
先执行第一条命令，等它结束后再执行第二条采集不同长度的日志。即使第一条失败也执行第二条，随后根据实际报告用两三句话交付验收结论，包含断言 ID 和实测值。
第一条：set -o pipefail; ${verificationCommand} title 2>&1 | tail -n 10
第二条：set -o pipefail; ${verificationCommand} title 2>&1 | tail -n 30`);
    assert.deepEqual(report.audit.verification.map(result => [result.outcome, result.launches]), [
      ['assertion_failed', 1], ['blocked_same_failure', 1],
    ]);
    // Models may append shell commands. Record the shell flags independently of the structured check outcome.
    report.auditShellFailuresPreserved = report.audit.verification.every(result => result.isError);
    assert.equal(report.audit.verification[0].reportPath, report.audit.verification[1].reportPath);
    assert.equal(launchCount(audit), 1);
    assert.equal(fs.readFileSync(path.join(audit, 'fixture-layout.txt'), 'utf8').trim(), 'broken');
    assert.match(report.audit.reply, /title-width/);
    assert.match(report.audit.reply, /broken/);
    report.checks.push('Real model reported the original assertion and ended after the repeated verification returned its existing report.');

    report.explanation = await prompt(auditId, 'audit-live-2', '为什么第二条没有启动验收？只解释原因，不改代码。');
    assert.deepEqual(report.explanation.verification, []);
    assert.equal(launchCount(audit), 1);
    report.checks.push('A new request for explanation completed with no verification launch.');
  }

  if (values.case !== 'audit') {
    const recoveryId = 'verification-recovery-live';
    const recovery = prepare(recoveryId);
    await register(recoveryId, recovery);
    report.recovery = await prompt(recoveryId, 'recovery-live-1', `完成这个独立工作区的桌面验收。先运行 ${verificationCommand} title 获取基线。
如果断言说明 fixture-layout.txt 里的 broken 导致失败，只将这个文件改成 fixed，再复验 title，最后用 ${verificationCommand} other 检查另一用例。用两三句话汇报实测结果。`);
    assert.deepEqual(report.recovery.verification.map(result => [result.caseId, result.outcome, result.launches]), [
      ['title', 'assertion_failed', 1], ['title', 'passed', 2], ['other', 'passed', 3],
    ]);
    assert.equal(fs.readFileSync(path.join(recovery, 'fixture-layout.txt'), 'utf8').trim(), 'fixed');
    assert.equal(launchCount(recovery), 3);
    report.checks.push('Relevant edited input reran the failed case successfully and another useful case still ran.');
  }
  assert(requests.some(request => request.model === report.modelConfiguration.modelId && request.tools?.some(tool => tool.function.name === 'bash')));
}, { name: 'desktop-verification-live', liveModel: true, watchRenderer: false, isolatedDependencyCache: true,
  settings: { permissionMode: 'auto', notificationPreferences: { desktopEnabled: false } }, rpcTimeoutMs: 180000 });
