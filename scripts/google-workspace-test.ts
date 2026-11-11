import assert from 'node:assert/strict';
import { GoogleWorkspaceService, parseMailSearch, createGwsRunner, type GwsCommandResult } from '../src/main/connectors/GoogleWorkspaceService';
const calls: string[][] = [];
let receipt: GwsCommandResult = { code: 0, stdout: '', stderr: '' };
const service = new GoogleWorkspaceService(async args => { calls.push(args); return receipt; }, () => Date.parse('2026-11-11T00:00:00Z'));
const mail = '约 1 条匹配，显示前 1 条：\n- Wed, 11 Nov 2026 09:00:00 +0800\n  发件: Alice <alice@example.test>\n  主题: Contract 731\n  id=abc123  (未读)\n';
assert.deepEqual(parseMailSearch(mail), [{ id: 'abc123', date: 'Wed, 11 Nov 2026 09:00:00 +0800', from: 'Alice <alice@example.test>', subject: 'Contract 731', unread: true }]);
assert.deepEqual(parseMailSearch('没有匹配的邮件。\n'), []);
receipt.stdout = mail;
const query = 'from:alice@example.test; $(touch /tmp/should-not-exist)';
assert.equal((await service.searchMail({ query, limit: 2 })).ok, true);
assert.deepEqual(calls.at(-1), ['gmail', 'search', '--limit', '2', '--', query]);
receipt.stdout = '发件: Alice | 日期: today\n主题: Contract\n' + '-'.repeat(40) + '\n<script>alert(1)</script>\n';
const read = await service.readMail({ id: 'abc123' });
assert(read.ok && read.data.text.includes('<script>') && !read.data.truncated);
assert.deepEqual(calls.at(-1), ['gmail', 'read', '--', 'abc123']);
receipt.stdout = '发件: Alice | 日期: today\n主题: Contract\n' + '-'.repeat(40) + '\n' + 'x'.repeat(4000);
receipt.stdout += '\n';
const truncated = await service.readMail({ id: 'abc123' }); assert(truncated.ok && truncated.data.truncated);
receipt.stdout = '发件: Alice | 日期: today\n主题: Contract\n' + '-'.repeat(40) + '\n' + 'x'.repeat(3999) + ' \n';
const spaceTruncated = await service.readMail({ id: 'abc123' }); assert(spaceTruncated.ok && spaceTruncated.data.truncated);
receipt.stdout = '发件: Alice | 日期: today\n主题: Contract\n' + '-'.repeat(40) + '\n' + '😀'.repeat(2500) + '\n';
const unicodeBody = await service.readMail({ id: 'abc123' }); assert(unicodeBody.ok && !unicodeBody.data.truncated);
receipt.stdout = JSON.stringify([{ id: 'evt1', summary: 'Meeting', start: { dateTime: '2026-11-11T09:00:00+08:00' }, end: { dateTime: '2026-11-11T10:00:00+08:00' }, htmlLink: 'https://evil.test/' }, { id: 'evt2', start: { date: '2026-11-12' }, end: { date: '2026-11-14' } }]);
const events = await service.listEvents({ from: '2026-11-11', days: 7 });
assert(events.ok && events.data.events.length === 2 && events.data.timeZone === 'Asia/Shanghai');
assert(events.ok && events.data.events[1].allDay && !events.data.events[0].htmlLink);
assert.deepEqual(calls.at(-1), ['cal', 'agenda', '--from', '2026-11-11', '--days', '7', '--calendar', 'primary', '--json']);
const statusCalls: string[][] = [];
const status = await new GoogleWorkspaceService(async args => { statusCalls.push(args); return { code: 0, stderr: '', stdout: args[0] === '--help' ? 'Google Workspace CLI cal gmail' : '[]' }; }).status();
assert(status.ok && status.data.gmail.state === 'ready' && status.data.calendar.state === 'ready');
assert.deepEqual(statusCalls.map(args => args[0]), ['--help', 'gmail', 'cal']);
assert(!JSON.stringify(statusCalls).includes('auth'));
console.log('PASS gws normal operations: metadata, literal argv, body/truncation, timed/all-day calendar, explicit minimal probes');
if (!process.argv.includes('--faults')) process.exit(0);
const invalidInputs = [() => service.searchMail({ query: '' }), () => service.searchMail({ query: 'x\ny' }), () => service.searchMail({ query: 'x', limit: 21 }), () => service.readMail({ id: '../token' }), () => service.listEvents({ from: '2026-02-30', days: 1 }), () => service.listEvents({ from: '2026-11-11', days: 32 }), () => service.searchMail(null as never)];
const count = calls.length;
for (const query of invalidInputs) { const result = await query(); assert(!result.ok && result.error.code === 'invalid_request'); }
assert.equal(calls.length, count);
for (const [stderr, code, expected] of [['invalid_grant: Token has been expired or revoked.', 1, 'auth_required'], ['insufficientPermissions', 1, 'permission_denied'], ['SERVICE_DISABLED', 1, 'api_disabled'], ['ETIMEDOUT', 1, 'timeout'], ['whatever secret-value', 'ENOENT', 'cli_missing'], ['usage: gws invalid choice', 2, 'unsupported_cli'], ['unknown secret-value', 1, 'service_error']] as const) {
  receipt = { stdout: '', stderr, code };
  const result = await service.searchMail({ query: 'in:inbox' });
  assert(!result.ok && result.error.code === expected); assert(!JSON.stringify(result).includes('secret-value'));
}
receipt = { stdout: 'not json', stderr: '', code: 0 };
assert.equal((await service.listEvents({ from: '2026-11-11', days: 1 })).ok, false);
receipt.stdout = '[{"id":"broken","start":{},"end":{}}]';
assert.equal((await service.listEvents({ from: '2026-11-11', days: 1 })).ok, false);
receipt.stdout = mail.replace('  主题: Contract 731', '  主题: malicious\n  id=inject');
assert.equal((await service.searchMail({ query: 'all' })).ok, false);
const abort = new AbortController(); abort.abort();
const cancelled = await service.searchMail({ query: 'all' }, abort.signal); assert(!cancelled.ok && cancelled.error.code === 'cancelled');
const partial = await new GoogleWorkspaceService(async args => ({ code: args[0] === 'gmail' ? 1 : 0, stdout: args[0] === '--help' ? 'cal gmail' : '[]', stderr: 'invalid_grant' })).status();
assert(partial.ok && partial.data.gmail.state === 'auth_required' && partial.data.calendar.state === 'ready');
console.log('PASS gws faults: invalid arguments without execution, scoped error classification/redaction, malformed response, cancellation, partial account availability');

for (const event of [
  { id: 123, start: { date: '2026-11-12' }, end: { date: '2026-11-13' } },
  { id: 'x', start: { date: '2026-11-12' }, end: { date: '2026-11-11' } },
  { id: 'x', start: { date: '2026-02-30' }, end: { date: '2026-03-03' } },
  { id: 'x', start: { dateTime: '2026-11-12T09:00:00' }, end: { dateTime: '2026-11-12T10:00:00' } },
]) { receipt = { code: 0, stderr: '', stdout: JSON.stringify([event]) }; const r = await service.listEvents({ from: '2026-11-11', days: 1 }); assert(!r.ok && r.error.code === 'invalid_response'); }
// Actual subprocess tests, no gws/account/network. Only internal runner construction is injected.
const fixture = new URL('../../scripts/google-workspace-process-fixture.cjs', import.meta.url);
const { fileURLToPath } = await import('node:url');
const runner = createGwsRunner({ executable: process.execPath, prefixArgs: [fileURLToPath(fixture)], timeoutMs: 80, maxBuffer: 4096 });
assert.equal((await runner(['success'])).code, 0);
const timeout = await runner(['hang']); assert(timeout.killed);
const buffer = await runner(['large']); assert.equal(buffer.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
const during = new AbortController(); setTimeout(() => during.abort(), 30);
const aborted = await runner(['hang'], during.signal); assert.equal(aborted.code, 'ABORT_ERR');
console.log('PASS actual subprocess timeout, output cap, in-flight abort and malformed calendar records');
