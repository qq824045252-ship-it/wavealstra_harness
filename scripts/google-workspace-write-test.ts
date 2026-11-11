import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GoogleWorkspaceWriteService, createGoogleWorkspaceWriteRunner, type GwsWriteRunner } from '../src/main/connectors/GoogleWorkspaceWriteService';
import { parseGwsWrapper } from '../src/main/platform/google-workspace-runtime';

const fixture = String.raw`
import json,base64
from email import policy
from email.parser import BytesParser
from pathlib import Path
root=Path(__file__).parent
class Response:
    def __init__(self,data): self.data=data; self.headers={}
    def execute(self,num_retries):
        assert num_retries==0
        if self.data.get('patch'): assert self.headers['If-Match']=='"fresh"'
        return self.data
class Users:
    def users(self): return self
    def messages(self): return self
    def getProfile(self,**kw):
        assert kw=={'userId':'me'}
        return Response({'emailAddress':'owner@example.com'})
    def send(self,**kw):
        assert kw['userId']=='me'
        m=BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(kw['body']['raw']))
        assert m['From']=='owner@example.com' and m['Date'] and m['Message-ID']
        assert m['To']=='recipient@example.com' and m['Subject']=='测试 ✓'
        assert 'private body' in m.get_content()
        (root/'mail-calls').write_text('sent')
        return Response({'id':'mail-id','threadId':'thread-id'})
class Calendar:
    def events(self): return self
    def get(self,**kw):
        event={'id':kw['eventId'],'etag':'"fresh"','summary':'Existing','start':{'date':'2026-11-11'},'end':{'date':'2026-11-12'}}
        if kw['eventId']=='recurring': event['recurrence']=['RRULE:FREQ=DAILY']
        if kw['eventId']=='attended': event['attendees']=[{'email':'Guest@example.com','responseStatus':'accepted','optional':True,'comment':'keep','additionalGuests':2}]
        if kw['eventId']=='timed': event.update(start={'dateTime':'2026-11-11T10:00:00Z','timeZone':'UTC'},end={'dateTime':'2026-11-11T11:00:00Z','timeZone':'UTC'})
        return Response(event)
    def insert(self,**kw):
        (root/'event-call').write_text(json.dumps(kw))
        return Response(dict(kw['body'],id='event-id',etag='"fresh"'))
    def patch(self,**kw):
        assert kw['sendUpdates'] in ['all','none']
        (root/'patch-call').write_text(json.dumps(kw))
        event=self.get(eventId=kw['eventId']).data
        for key,value in kw['body'].items():
            if key in ['start','end']:
                for nested,item in value.items():
                    if item is None: event[key].pop(nested,None)
                    else: event[key][nested]=item
                assert not ('date' in event[key] and 'dateTime' in event[key])
            else: event[key]=value
        event.update(etag='"changed"',patch=True)
        return Response(event)
def svc(name,version):
    assert (name,version) in [('gmail','v1'),('calendar','v3')]
    return Users() if name=='gmail' else Calendar()
`;
const dir = await mkdtemp(join(tmpdir(), 'gws-write-test-'));
try {
  let python = '';
  for (const executable of ['python3', 'python']) {
    try { python = execFileSync(executable, ['-c', 'import sys; assert sys.version_info >= (3,9); print(sys.executable)'], { encoding: 'utf8', timeout: 5000 }).trim(); break; } catch { /* Try another standard Python command. */ }
  }
  assert.ok(python, 'Synthetic SDK process tests require Python 3.9+; no installed gws is used.');
  const module = join(dir, 'gws.py'); await writeFile(module, fixture);
  // Explicit fixture injection, never PATH discovery or the installed gws.
  const runner = createGoogleWorkspaceWriteRunner(async () => ({ python, module }));
  const journalDirectory = join(dir, 'journal');
  const service = new GoogleWorkspaceWriteService({ runner, journalDirectory });
  const mail = { operationId: 'mail-operation-01', to: ['recipient@example.com'], subject: '测试 ✓', body: 'private body' };
  assert.equal((await service.sendMail(mail)).ok, true);
  assert.equal(await readFile(join(dir, 'mail-calls'), 'utf8'), 'sent');
  console.log('PASS MIME Unicode/From/Date/Message-ID and SDK send');
  assert.equal((await service.sendMail({ ...mail, operationId: 'bad-header-01', subject: 'bad\r\nBcc: outsider@example.com' })).ok, false);
  assert.equal((await service.sendMail({ ...mail, operationId: 'bad-address-01', to: ['Named <recipient@example.com>'] })).ok, false);
  console.log('PASS header injection and non-address recipients rejected');
  let calls = 0;
  const counted: GwsWriteRunner = async (...args) => { calls++; return runner(...args); };
  const restarted = new GoogleWorkspaceWriteService({ runner: counted, journalDirectory });
  assert.equal((await restarted.sendMail(mail)).ok, true); assert.equal(calls, 0);
  const conflict = await restarted.sendMail({ ...mail, body: 'changed' });
  assert.ok(!conflict.ok && conflict.error.code === 'idempotency_conflict');
  console.log('PASS restart-safe replay and payload conflict');
  const event = { operationId: 'event-operation-01', title: 'Private title', start: '2026-11-11', end: '2026-11-12', allDay: true };
  assert.equal((await service.createEvent(event)).ok, true);
  assert.equal(JSON.parse(await readFile(join(dir, 'event-call'), 'utf8')).sendUpdates, 'none');
  assert.equal((await service.createEvent({ ...event, operationId: 'invalid-date-01', end: '2026-11-11' })).ok, false);
  assert.equal((await service.createEvent({ ...event, operationId: 'invalid-date-02', start: '2026-02-30' })).ok, false);
  console.log('PASS exclusive all-day end and invalid dates');
  assert.equal((await service.createEvent({ ...event, operationId: 'attendees-no-01', attendees: ['guest@example.com'] })).ok, false);
  assert.equal((await service.createEvent({ ...event, operationId: 'attendees-yes-01', attendees: ['guest@example.com'], notifyAttendees: true })).ok, true);
  assert.equal(JSON.parse(await readFile(join(dir, 'event-call'), 'utf8')).sendUpdates, 'all');
  console.log('PASS explicit attendee notification scope');
  const stale = await service.updateEvent({ operationId: 'update-stale-01', id: 'event-id', etag: 'stale', title: 'Changed' });
  assert.ok(!stale.ok && stale.error.code === 'conflict');
  assert.equal((await service.updateEvent({ operationId: 'update-fresh-01', id: 'event-id', etag: '"fresh"', title: 'Changed' })).ok, true);
  assert.equal((await service.updateEvent({ operationId: 'update-series-01', id: 'recurring', etag: '"fresh"', title: 'Changed' })).ok, false);
  assert.equal((await service.updateEvent({ operationId: 'update-guests-01', id: 'attended', etag: '"fresh"', title: 'Changed' })).ok, false);
  console.log('PASS If-Match, stale edits, recurring scope and existing attendees');
  assert.equal((await service.updateEvent({ operationId: 'update-guests-02', id: 'attended', etag: '"fresh"', attendees: ['guest@example.com', 'new@example.com'], notifyAttendees: true })).ok, true);
  const guests = JSON.parse(await readFile(join(dir, 'patch-call'), 'utf8')).body.attendees;
  assert.deepEqual(guests[0], { email: 'guest@example.com', responseStatus: 'accepted', optional: true, comment: 'keep', additionalGuests: 2 });
  assert.equal((await service.updateEvent({ operationId: 'convert-to-timed', id: 'event-id', etag: '"fresh"', allDay: false, start: '2026-11-11T10:00:00Z', end: '2026-11-11T11:00:00Z' })).ok, true);
  assert.equal((await service.updateEvent({ operationId: 'convert-to-day', id: 'timed', etag: '"fresh"', allDay: true, start: '2026-11-11', end: '2026-11-12' })).ok, true);
  console.log('PASS attendee metadata retained and date/dateTime nested PATCH conversion');
  let finish!: () => void; let executions = 0;
  const waiting = new GoogleWorkspaceWriteService({ journalDirectory: join(dir, 'concurrent'), runner: async () => {
    executions++; await new Promise<void>(resolve => { finish = resolve; });
    return { ok: true, data: { id: 'once', operationId: 'concurrent-op' }, checkedAt: Date.now() };
  } });
  const first = waiting.sendMail({ ...mail, operationId: 'concurrent-op' });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await waiting.sendMail({ ...mail, operationId: 'concurrent-op' });
  assert.ok(!second.ok && second.error.outcome === 'unknown'); finish(); await first; assert.equal(executions, 1);
  console.log('PASS concurrent duplicate cannot execute');
  const unknownDir = join(dir, 'unknown');
  const uncertain = new GoogleWorkspaceWriteService({ journalDirectory: unknownDir, runner: async () => { throw new Error('lost connection secret'); } });
  assert.equal((await uncertain.sendMail(mail)).ok, false);
  const noRetry = new GoogleWorkspaceWriteService({ journalDirectory: unknownDir, runner: async () => { throw new Error('must not execute'); } });
  const unknown = await noRetry.sendMail(mail); assert.ok(!unknown.ok && unknown.error.outcome === 'unknown');
  console.log('PASS unknown outcomes never replay');
  let authAttempts = 0;
  const reauth = new GoogleWorkspaceWriteService({ journalDirectory: join(dir, 'reauth'), runner: async () => ++authAttempts === 1
    ? { ok: false, error: { code: 'auth_required', message: 'fixture', outcome: 'not_started' }, checkedAt: Date.now() }
    : { ok: true, data: { id: 'after-reauth', operationId: mail.operationId }, checkedAt: Date.now() } });
  assert.equal((await reauth.sendMail(mail)).ok, false); assert.equal(authAttempts, 1);
  assert.equal((await reauth.sendMail(mail)).ok, true); assert.equal(authAttempts, 2);
  assert.equal((await reauth.sendMail(mail)).ok, true); assert.equal(authAttempts, 2);
  console.log('PASS explicit same-key retry after definite auth failure, never automatic');
  const scopedDir = join(dir, 'scoped-unknown'); let scopedCalls = 0;
  const scopedRunner: GwsWriteRunner = async () => { scopedCalls++; return { ok: false, error: { code: 'timeout', message: 'fixture', outcome: 'unknown' }, checkedAt: Date.now() }; };
  const scoped = new GoogleWorkspaceWriteService({ journalDirectory: scopedDir, runner: scopedRunner });
  const scope = 'host-user-run-private-identity';
  const scopedUnknown = await scoped.sendMail({ ...mail, operationId: 'scope-mail-01' }, undefined, scope);
  assert.ok(!scopedUnknown.ok && scopedUnknown.error.outcome === 'unknown');
  const scopedRestart = new GoogleWorkspaceWriteService({ journalDirectory: scopedDir, runner: scopedRunner });
  for (const blocked of [
    await scopedRestart.sendMail({ ...mail, operationId: 'scope-mail-02', body: 'changed too' }, undefined, scope),
    await scopedRestart.createEvent({ ...event, operationId: 'scope-event-01' }, undefined, scope),
    await scopedRestart.updateEvent({ operationId: 'scope-update-01', id: 'event-id', etag: '"fresh"', title: 'changed' }, undefined, scope)
  ]) assert.ok(!blocked.ok && blocked.error.outcome === 'unknown');
  assert.equal(scopedCalls, 1);
  // A distinct host request is independently authorized, not blocked forever.
  await scopedRestart.sendMail({ ...mail, operationId: 'scope-other-01' }, undefined, 'another-host-run');
  assert.equal(scopedCalls, 2);
  console.log('PASS unknown scope blocks fresh operation IDs, changed content/actions and restart');
  let definiteCalls = 0;
  const definiteScope = new GoogleWorkspaceWriteService({ journalDirectory: join(dir, 'scope-definite'), runner: async () => {
    definiteCalls++;
    return definiteCalls === 1 ? { ok: false, error: { code: 'auth_required', message: 'fixture', outcome: 'not_started' }, checkedAt: Date.now() }
      : { ok: true, data: { id: 'definite', operationId: 'fixture' }, checkedAt: Date.now() };
  } });
  assert.equal((await definiteScope.sendMail({ ...mail, operationId: 'definite-mail-01' }, undefined, scope)).ok, false);
  assert.equal((await definiteScope.sendMail({ ...mail, operationId: 'definite-mail-01' }, undefined, scope)).ok, true);
  assert.equal((await definiteScope.createEvent({ ...event, operationId: 'definite-event-01' }, undefined, scope)).ok, true);
  assert.equal(definiteCalls, 3);
  console.log('PASS scope releases after definite failure/success for later actions');
  let releaseScope!: () => void; let concurrentScopeCalls = 0;
  const concurrentScopeDir = join(dir, 'scope-concurrent');
  const concurrentScopeRunner: GwsWriteRunner = async () => {
    concurrentScopeCalls++; await new Promise<void>(resolve => { releaseScope = resolve; });
    return { ok: true, data: { id: 'scope-once', operationId: 'fixture' }, checkedAt: Date.now() };
  };
  const concurrentScope = new GoogleWorkspaceWriteService({ journalDirectory: concurrentScopeDir, runner: concurrentScopeRunner });
  const pendingScope = concurrentScope.sendMail({ ...mail, operationId: 'concurrent-scope-01' }, undefined, scope);
  while (!releaseScope) await new Promise(resolve => setTimeout(resolve, 5));
  // Separate instance represents another process or a restart with a pending claim.
  const pendingRestart = new GoogleWorkspaceWriteService({ journalDirectory: concurrentScopeDir, runner: concurrentScopeRunner });
  const deniedScope = await pendingRestart.createEvent({ ...event, operationId: 'concurrent-scope-02' }, undefined, scope);
  assert.ok(!deniedScope.ok && deniedScope.error.outcome === 'unknown'); assert.equal(concurrentScopeCalls, 1);
  releaseScope(); await pendingScope;
  console.log('PASS persistent pending scope blocks concurrent cross-action writes');
  const badScopePath = join(dir, 'scope-not-directory'); await writeFile(badScopePath, 'fixture');
  const unavailableScope = new GoogleWorkspaceWriteService({ journalDirectory: badScopePath, runner: scopedRunner });
  const setupFailure = await unavailableScope.sendMail(mail, undefined, scope);
  assert.ok(!setupFailure.ok && setupFailure.error.outcome === 'not_started'); assert.equal(scopedCalls, 2);
  const injectedScope = await scoped.sendMail({ ...mail, operationId: 'injected-scope-01', requestScope: 'model-controlled' } as typeof mail);
  assert.ok(!injectedScope.ok && injectedScope.error.code === 'invalid_request');
  const { readdir: listScope, stat: scopeStat } = await import('node:fs/promises');
  const scopeFiles = (await listScope(scopedDir)).filter(name => name.startsWith('scope-'));
  for (const name of scopeFiles) {
    assert.match(name, /^scope-[a-f0-9]{64}\.lock$/);
    assert.equal(await readFile(join(scopedDir, name), 'utf8'), '{"state":"pending"}');
    if (process.platform !== 'win32') assert.equal((await scopeStat(join(scopedDir, name))).mode & 0o777, 0o600);
  }
  console.log('PASS scope setup failures not_started; JSON scope rejected; private lock metadata');
  await mkdir(join(dir, 'hang')); const hang = join(dir, 'hang', 'gws.py'); await writeFile(hang, 'import time\ntime.sleep(10)\n');
  const timeout = await createGoogleWorkspaceWriteRunner(async () => ({ python, module: hang }), 50)('sendMail', mail);
  assert.ok(!timeout.ok && timeout.error.outcome === 'unknown');
  const abort = new AbortController(); abort.abort();
  const cancelled = await service.sendMail({ ...mail, operationId: 'cancel-before-01' }, abort.signal);
  assert.ok(!cancelled.ok && cancelled.error.outcome === 'not_started');
  console.log('PASS process timeout unknown and pre-start cancellation');
  assert.deepEqual(parseGwsWrapper('#!/bin/sh\nexec /fake/python /fake/gws.py "$@"\n'), { python: '/fake/python', module: '/fake/gws.py' });
  assert.equal(parseGwsWrapper('#!/bin/sh\nexec $(evil) /fake/gws.py "$@"\n'), undefined);
  assert.equal(parseGwsWrapper('#!/bin/sh\nexec /fake/python /fake/gws.py "$@"; evil\n'), undefined);
  console.log('PASS wrapper parser rejects shell evaluation');
  const { readdir } = await import('node:fs/promises');
  const journal = (await Promise.all((await readdir(journalDirectory)).map(name => readFile(join(journalDirectory, name), 'utf8')))).join('\n');
  assert.ok(!journal.includes('private body') && !journal.includes('Private title') && !journal.includes('guest@example.com'));
  console.log('PASS journal excludes mail/event content');
} finally { await rm(dir, { recursive: true, force: true }); }
