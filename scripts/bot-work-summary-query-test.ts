import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { WorkListQuery } from '../src/main/agent/work/WorkListQuery';
import { WorkProjectionJournal } from '../src/main/agent/work/WorkProjectionJournal';
import { LOCAL_USER_ID, DEFAULT_BOT_ID, type WorkActor } from '../src/shared/bot-work';
import { canArchiveWork } from '../src/shared/bot-work-archive';
import { workStatus } from '../src/renderer/src/lib/botWorkspacePresentation';
const root = mkdtempSync(join(tmpdir(), 'work-summary-query-'));
const db = new AppDatabase(join(root, 'test.db'));
const bots = new BotRegistry(db.connection);
bots.ensureDefaultBot(LOCAL_USER_ID);
const emitted: import('../src/shared/bot-work').WorkProjectionDto[] = [];
const works = new WorkService(db.connection, { bots, emitProjection: value => emitted.push(value) });
const query = new WorkListQuery(db.connection, () => works.scheduler.hostState().online);
const actor: WorkActor = { kind: 'user', userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const create = (id: string) => { const r = works.createWork(actor, { operationId: id, title: id, authorization: DESKTOP_USER_GRANTS }); if (!r.ok)
    throw Error(r.message); return r.work; };
try {
    const first = create('seed');
    const columns = (db.connection.prepare('PRAGMA table_info(works)').all() as {
        name: string;
    }[]).map(x => x.name);
    const clone = db.connection.prepare(`INSERT INTO works(${columns.join(',')}) SELECT ${columns.map(c => c === 'work_id' ? '@id' : c === 'title' ? '@title' : c === 'updated_at' ? '@time' : c === 'goal_description' ? '@goal' : c).join(',')} FROM works WHERE work_id=@seed`);
    db.connection.transaction(() => { for (let i = 0; i < 2500; i++)
        clone.run({ id: `bulk-${String(i).padStart(4, '0')}`, title: `Item ${i}`, time: 1000 + i, goal: i === 1000 ? 'Hidden full goal ＡＢＣ café 细节' : '', seed: first.workId }); })();
    let result = query.query(LOCAL_USER_ID, { scope: { kind: 'personal', botId: DEFAULT_BOT_ID }, view: 'all' });
    assert.equal(result.total, 2501);
    assert.equal(result.works.length, 24);
    assert.equal(result.pages, 105);
    assert.ok(result.works.every(w => w.listSummary && w.executions.length === 0 && w.criteria.length === 0));
    const second = query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', page: 2 });
    assert.equal(new Set([...result.works, ...second.works].map(w => w.workId)).size, 48);
    const search = query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', query: 'abc CAFÉ 细节' });
    assert.equal(search.filtered, 1);
    assert.equal(search.works[0].workId, 'bulk-1000');
    assert.equal(search.works[0].goalDescription, undefined, 'full goal stays on detail endpoint');
    const end = query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', page: 99999 });
    assert.equal(end.page, 105);
    assert.equal(end.works.length, 5);
    assert.throws(() => query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, pageSize: 101 }));
    db.connection.prepare('UPDATE works SET updated_at=9999999999999 WHERE work_id=?').run('bulk-0000');
    const changed = query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', watermark: result.watermark });
    assert.equal(changed.works[0].workId, 'bulk-0000');
    assert.ok(changed.watermark.sequence > result.watermark.sequence);
    db.connection.prepare("INSERT INTO work_record_archive(work_id,archived_at,deleted_at) VALUES ('bulk-0000',1,2)").run();
    assert.equal(query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all' }).total, 2500);
    assert.equal(query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all' }).deletedCount, 1);
    assert.equal(query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', showDeleted: true }).total, 1);
    assert.equal(query.get(LOCAL_USER_ID, 'bulk-0000')?.archive?.deletedAt, 2);
    assert.equal(query.get('foreign', 'bulk-0000'), undefined);
    assert.equal(query.query('foreign', { scope: { kind: 'all' }, view: 'all' }).total, 0);
    assert.equal(query.query(LOCAL_USER_ID, { scope: { kind: 'personal', botId: 'foreign-bot' }, view: 'all' }).total, 0);
    for (const lifecycle of ['active', 'paused', 'closing', 'closed'])
        for (const conclusion of [null, 'succeeded', 'cancelled', 'ended_unsuccessfully']) {
            db.connection.prepare('UPDATE works SET lifecycle=?,closure_conclusion=? WHERE work_id=?').run(lifecycle, conclusion, first.workId);
            const detail = works.getProjection(first.workId)!;
            assert.deepEqual(query.get(LOCAL_USER_ID, first.workId)?.listSummary?.status, workStatus(detail));
            for (const step of detail.nextSteps) assert.equal(query.query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:`${first.workId} ${step}`}).filtered,1,step);
        }
    assert.equal(query.get(LOCAL_USER_ID,'bulk-0001')?.listSummary?.excerpt,'安排后台执行');
    assert.equal(query.get(LOCAL_USER_ID,'bulk-0001')?.listSummary?.hasResultExcerpt,false);
    const subject = create('status-subject');
    const addBinding = (id: string, workId = subject.workId) => db.connection.prepare(`INSERT INTO work_execution_bindings
 (binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,intent_revision,owner_epoch,input_snapshot_id,expert_snapshot_json,delegated_scope_json,workspace_binding,status,admitted_at)
 SELECT @id,work_id,@id,owner_bot_id,@id,@id,@id,intent_revision,owner_epoch,input_snapshot_id,'{}','[]','test','pending',1 FROM works WHERE work_id=@workId`).run({ id, workId });
    addBinding('status-binding');
    const parity = () => {
        const detail = works.getProjection(subject.workId)!;
        const summary = query.get(LOCAL_USER_ID, subject.workId)!;
        assert.deepEqual(summary.listSummary?.status, workStatus(detail), `status parity ${detail.mode}/${detail.executions[0]?.status}`);
        assert.equal(summary.listSummary?.canArchive, canArchiveWork(detail), 'archive eligibility parity');
        for (const step of detail.nextSteps) assert.equal(query.query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:`${subject.workId} ${step}`}).filtered,1,step);
        assert.equal(query.query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:`${subject.workId} 安排后台执行`}).filtered,
            detail.nextSteps.includes('安排后台执行')?1:0, 'no invented idle guidance in search');
    };
    for (const mode of ['once', 'watch'])
        for (const status of ['pending', 'submitted', 'running', 'unknown', 'completed', 'failed', 'stopped', 'invalidated']) {
            db.connection.prepare('UPDATE works SET mode=? WHERE work_id=?').run(mode, subject.workId);
            db.connection.prepare("UPDATE work_execution_bindings SET status=? WHERE binding_id='status-binding'").run(status);
            parity();
        }
    db.connection.prepare("UPDATE work_execution_bindings SET status='completed' WHERE binding_id='status-binding'").run();
    db.connection.prepare("UPDATE works SET mode='once',input_snapshot_id='snapshot:bound',criteria_json=? WHERE work_id=?").run(JSON.stringify([{ id: 'c', text: '验收文字 🔎', status: 'satisfied', requiredIntentRevision: 1, evidenceRefs: [] }]), subject.workId);
    db.connection.prepare("UPDATE work_execution_bindings SET input_snapshot_id='snapshot:bound' WHERE binding_id='status-binding'").run();
    parity();
    db.connection.prepare("UPDATE works SET criteria_json=json_set(criteria_json,'$[0].status','failed') WHERE work_id=?").run(subject.workId);
    parity();
    db.connection.prepare("UPDATE works SET criteria_json=json_set(criteria_json,'$[0].status','satisfied') WHERE work_id=?").run(subject.workId);
    db.connection.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,waiting_for_user_input,status,created_at) VALUES ('blocker',?,'need decision','operational',1,'open',1)`).run(subject.workId);
    parity();
    db.connection.prepare("UPDATE work_blockers SET waiting_for_user_input=0 WHERE blocker_id='blocker'").run();
    parity();
    db.connection.prepare("UPDATE work_blockers SET status='cleared' WHERE blocker_id='blocker'").run();
    parity();
    // Old revisions cannot revive errors; runtime observations only exist for unsettled bindings.
    addBinding('historical-binding');
    db.connection.prepare("UPDATE work_execution_bindings SET status='running',intent_revision=2 WHERE binding_id='historical-binding'").run();
    parity();
    assert.equal(query.get(LOCAL_USER_ID, subject.workId)?.listSummary?.running, false);
    assert.deepEqual(query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', candidateTaskIds: ['historical-binding', 'unknown-task'] }).workExecutionTaskIds, ['historical-binding']);
    assert.deepEqual(query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all' }).workExecutionTaskIds, []);
    assert.deepEqual(query.query('foreign', { scope: { kind: 'all' }, view: 'all', candidateTaskIds: ['historical-binding'] }).workExecutionTaskIds, []);
    assert.throws(() => query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, candidateTaskIds: Array(501).fill('x') }));
    db.connection.prepare("UPDATE work_execution_bindings SET status='completed' WHERE binding_id='historical-binding'").run();
    db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,status,summary,artifact_refs_json,created_at)
 VALUES ('search-deliverable',?,?,'status-binding',1,1,'snapshot:bound','proposed',?,'["/deep/path/old-result.txt"]',1)`).run(subject.workId, DEFAULT_BOT_ID, 'x'.repeat(12000) + ' full-report-tail');
    assert.equal(query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', query: 'full-report-tail old-result.txt 验收文字' }).filtered, 1);
    assert.ok(query.get(LOCAL_USER_ID, subject.workId)!.listSummary!.excerpt.length <= 600);
    db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,status,summary,created_at)
      VALUES ('rejected-newest',?,?,'status-binding',1,1,'snapshot:bound','rejected','Rejected content must not be the card preview',999)`).run(subject.workId,DEFAULT_BOT_ID);
    assert.equal(query.get(LOCAL_USER_ID,subject.workId)?.listSummary?.excerpt,'x'.repeat(600));
    assert.equal(query.get(LOCAL_USER_ID,subject.workId)?.listSummary?.hasResultExcerpt,true);
    const blockedItem = { itemId: 'gap-item', task: 'finish actual work', required: true, dependencies: [], criterionIds: [], nativeStatus: 'test', outcome: 'blocked', artifactRefs: [], writeConflicts: [], summary: 'not done' };
    db.connection.prepare(`INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at) VALUES ('gap-fact',?,'status-binding','gap-item',?,1)`).run(subject.workId, JSON.stringify(blockedItem));
    parity();
    assert.equal(query.get(LOCAL_USER_ID,subject.workId)?.listSummary?.status.label, '执行已结束 · 尚有缺口');
    addBinding('continuation-binding');
    db.connection.prepare("UPDATE work_execution_bindings SET status='completed' WHERE binding_id='continuation-binding'").run();
    db.connection.prepare(`INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,input_snapshot_id,owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at)
     VALUES ('continuation-plan',?,'status-binding','continuation-op',1,'snapshot:bound',1,?,'["gap-item"]','fill gap','settled',1)`).run(subject.workId, DEFAULT_BOT_ID);
    db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id)
     VALUES ('continuation-dispatch',?,'continuation-binding',?,1,'snapshot:bound','dispatched',1,'continuation-plan')`).run(subject.workId, DEFAULT_BOT_ID);
    db.connection.prepare(`INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at) VALUES ('continuation-fact',?,'continuation-binding','gap-item',?,2)`).run(subject.workId, JSON.stringify({...blockedItem,outcome:'completed'}));
    parity();
    assert.equal(query.get(LOCAL_USER_ID,subject.workId)?.listSummary?.status.label, '正在整理最终结果');
    const onlineQuery = new WorkListQuery(db.connection, () => true);
    const watchParity = () => {
        const detail = works.getProjection(subject.workId)!;
        detail.phase4!.host.online = true;
        detail.phase4!.subscriptions = detail.phase4!.subscriptions.map(s => ({...s,status:s.status==='offline'?'online':s.status}));
        assert.deepEqual(onlineQuery.get(LOCAL_USER_ID,subject.workId)?.listSummary?.status, workStatus(detail));
    };
    db.connection.prepare("UPDATE works SET mode='watch' WHERE work_id=?").run(subject.workId);
    watchParity();
    db.connection.prepare(`INSERT INTO work_subscriptions(subscription_id,work_id,source,catch_up_policy,max_merge_wait_ms,max_queue_depth,next_wake_at,created_at,updated_at)
     VALUES ('watch-sub',?,'cron','latest',0,10,5000,1,1)`).run(subject.workId);
    watchParity();
    assert.equal(onlineQuery.get(LOCAL_USER_ID,subject.workId)?.listSummary?.nextCheckAt,5000);
    for (const status of ['running','submitted','pending','unknown','failed','stopped','completed']) {
        db.connection.prepare("UPDATE work_execution_bindings SET status=? WHERE binding_id='status-binding'").run(status);
        watchParity();
    }
    // Same-millisecond retries use row insertion order consistently in detail and SQL.
    db.connection.prepare("UPDATE work_execution_bindings SET status='unknown' WHERE binding_id='status-binding'").run();
    addBinding('same-time-later');
    db.connection.prepare("UPDATE work_execution_bindings SET task_id='status-binding',status='completed' WHERE binding_id='same-time-later'").run();
    watchParity();
    assert.equal(onlineQuery.get(LOCAL_USER_ID,subject.workId)?.listSummary?.status.label,'等待下次检查');
    db.connection.prepare("UPDATE work_execution_bindings SET status='completed' WHERE binding_id='status-binding'").run();
    db.connection.prepare("UPDATE work_subscriptions SET source='event',next_wake_at=NULL WHERE subscription_id='watch-sub'").run();
    watchParity();
    db.connection.prepare(`INSERT INTO work_events_inbox(event_id,dedupe_key,source,source_event_id,event_type,work_id,subscription_id,intent_revision,state_version,owner_epoch,payload_json,status,received_at)
     SELECT 'watch-event','watch-event','event','watch-event','source_changed',work_id,'watch-sub',intent_revision,state_version,owner_epoch,'{}','pending',1 FROM works WHERE work_id=?`).run(subject.workId);
    watchParity();
    db.connection.prepare("UPDATE work_events_inbox SET status='blocked' WHERE event_id='watch-event'").run();
    watchParity();
    db.connection.prepare("UPDATE work_events_inbox SET status='pending',frozen_at=2 WHERE event_id='watch-event'").run();
    watchParity();
    db.connection.prepare("UPDATE work_events_inbox SET status='processed' WHERE event_id='watch-event'").run();
    db.connection.prepare("UPDATE work_subscriptions SET stopped_at=2 WHERE subscription_id='watch-sub'").run();
    watchParity();
    db.connection.prepare("UPDATE works SET lifecycle='closed',watch_rule_json=? WHERE work_id=?").run(JSON.stringify({termination:{reason:'schedule_expired',settledAt:1}}),subject.workId);
    watchParity();
    assert.equal(onlineQuery.get(LOCAL_USER_ID,subject.workId)?.listSummary?.status.label,'到期结束');
    db.connection.prepare("UPDATE works SET lifecycle='active',watch_rule_json=NULL WHERE work_id=?").run(subject.workId);
    let hostOnline = false;
    const changingHost = new WorkListQuery(db.connection,()=>hostOnline);
    const offlinePage = changingHost.query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:subject.workId});
    hostOnline = true;
    const onlinePage = changingHost.query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:subject.workId});
    assert.notEqual(offlinePage.watermark.revision,onlinePage.watermark.revision);
    db.connection.prepare("UPDATE works SET mode='once' WHERE work_id=?").run(subject.workId);
    const teamWork = create('team-subject'), removed = create('removed-team-subject'), historical = create('historical-team-subject');
    const plan = JSON.stringify({ ownerBotId: DEFAULT_BOT_ID, ownerResponsibility: 'manage', members: [{ botId: 'member', responsibility: 'execute', delegatedScope: [] }] });
    db.connection.prepare(`INSERT INTO work_team_templates(template_id,user_id,operation_id,request_hash,name,plan_json,created_at) VALUES ('team',?,'team-op','hash','Team',?,1)`).run(LOCAL_USER_ID, plan);
    for (const work of [teamWork, removed, historical])
        db.connection.prepare(`INSERT INTO work_teams(work_id,user_id,operation_id,request_hash,plan_json,intent_revision,input_snapshot_id,created_at) VALUES (?,?,?,'hash',?,1,?,1)`).run(work.workId, LOCAL_USER_ID, work.workId, plan, work.inputSnapshotId);
    for (const work of [teamWork, removed])
        db.connection.prepare("INSERT INTO work_team_ownership(work_id,team_id,team_name) VALUES (?,'team','Team')").run(work.workId);
    db.connection.prepare('INSERT INTO work_team_record_visibility(work_id,removed_at) VALUES (?,1)').run(removed.workId);
    assert.deepEqual(query.query(LOCAL_USER_ID, { scope: { kind: 'team', teamId: 'team' }, view: 'all' }).works.map(w => w.workId), [teamWork.workId]);
    assert.deepEqual(query.query(LOCAL_USER_ID, { scope: { kind: 'historical_teams' }, view: 'all' }).works.map(w => w.workId), [historical.workId]);
    assert.deepEqual(query.query(LOCAL_USER_ID, { scope: { kind: 'removed_teams' }, view: 'all' }).works.map(w => w.workId), [removed.workId]);
    assert.equal(query.query('foreign', { scope: { kind: 'team', teamId: 'team' }, view: 'all' }).total, 0);
    assert.ok(!query.query(LOCAL_USER_ID, { scope: { kind: 'personal', botId: DEFAULT_BOT_ID }, view: 'all', query: 'team-subject' }).works.length);
    db.connection.prepare("UPDATE work_team_templates SET deleted_at=1 WHERE template_id='team'").run();
    assert.equal(query.query(LOCAL_USER_ID, { scope: { kind: 'historical_teams' }, view: 'all' }).total, 2);
    const competing = new Database(join(root, 'test.db'), { timeout: 0 });
    let competingAttempt = false;
    db.connection.function('work_list_matches', { deterministic: true }, (_text: unknown, _query: unknown) => {
        if (!competingAttempt) {
            competingAttempt = true;
            assert.throws(() => competing.prepare("UPDATE works SET state_version=state_version+1 WHERE work_id=?").run(subject.workId),
                (error: unknown) => (error as { code?: string }).code === 'SQLITE_BUSY');
        }
        return 1;
    });
    const atomic = query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', query: 'force callback' });
    assert.ok(competingAttempt);
    assert.deepEqual({epoch:atomic.watermark.epoch,sequence:atomic.watermark.sequence}, db.connection.prepare('SELECT epoch,sequence FROM work_projection_streams WHERE user_id=?').get(LOCAL_USER_ID));
    competing.close();
    new WorkListQuery(db.connection, () => works.scheduler.hostState().online); // Restore the Unicode matcher.
    works.getProjection = () => { throw Error('full projection forbidden'); };
    works.listProjections = () => { throw Error('full list forbidden'); };
    const measure = (label: string, term = '') => {
        const start = performance.now();
        const page = query.query(LOCAL_USER_ID, { scope: { kind: 'all' }, view: 'all', query: term });
        console.log(`BENCH ${label}: ${(performance.now() - start).toFixed(1)} ms; ${Buffer.byteLength(JSON.stringify(page))} bytes; ${page.works.length} hydrated summaries; 0 full projections`);
    };
    measure('2500 light rows');
    db.connection.transaction(() => {
        for (let i = 2500; i < 50000; i++) clone.run({ id: `bulk-${String(i).padStart(5, '0')}`, title: `Item ${i}`, time: 1000 + i, goal: '', seed: subject.workId });
    })();
    measure('50000 light rows cold');
    measure('50000 light rows hot');
    db.connection.prepare("UPDATE works SET updated_at=9999999999998 WHERE work_id='bulk-0001'").run();
    measure('50000 rows after sort write');
    const heavy = db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,status,summary,artifact_refs_json,created_at)
      VALUES (?, ?, ?, 'unbound-report', 1, 1, 'snapshot:bound', 'proposed', ?, '[]', 1)`);
    db.connection.transaction(() => { for (let i = 0; i < 200; i++) heavy.run(`heavy-${i}`, `bulk-${String(i).padStart(4, '0')}`, DEFAULT_BOT_ID, 'large report '.repeat(6000) + ' HeavyReportTail'); })();
    measure('50000 rows and 200 heavy reports');
    measure('50000 rows full-report search cold', 'HeavyReportTail');
    measure('50000 rows full-report search hot', 'HeavyReportTail');
    const externalWriter = new Database(join(root, 'test.db'));
    // Related fact changes intentionally do not advance the journal. data_version must
    // still invalidate an otherwise identical cached request.
    const oldPage = query.query(LOCAL_USER_ID, {scope:{kind:'all'},view:'all',query:'external-only-marker'});
    assert.equal(oldPage.filtered,0);
    externalWriter.prepare("UPDATE work_deliverables SET summary='external-only-marker' WHERE deliverable_id='heavy-1'").run();
    const externalPage = query.query(LOCAL_USER_ID, {scope:{kind:'all'},view:'all',query:'external-only-marker'});
    assert.equal(externalPage.filtered,1);
    assert.equal(oldPage.watermark.sequence,externalPage.watermark.sequence,'external fact mutation does not need a Work version bump');
    assert.equal(oldPage.watermark.epoch,externalPage.watermark.epoch);
    assert.notEqual(oldPage.watermark.revision,externalPage.watermark.revision,'external facts change page revision');
    externalWriter.close();
    assert.throws(() => db.connection.transaction(() => {
        db.connection.prepare("UPDATE works SET title='rolled back title' WHERE work_id=?").run(subject.workId);
        assert.equal(query.query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:'rolled back title'}).filtered,1);
        throw Error('rollback fixture');
    })());
    assert.equal(query.query(LOCAL_USER_ID,{scope:{kind:'all'},view:'all',query:'rolled back title'}).filtered,0);
    // A summary reader must never call full detail/repository projections, even for replay.
    works.getProjection = () => { throw Error('full projection forbidden'); };
    works.listProjections = () => { throw Error('full list forbidden'); };
    works.emitCurrentProjection(subject.workId,{force:true});
    assert.ok(emitted.at(-1)?.listSummary);
    assert.deepEqual(emitted.at(-1)?.executions,[]);
    assert.deepEqual(emitted.at(-1)?.deliverables,[]);
    const journal = new WorkProjectionJournal(db.connection, works);
    const snapshot = journal.sync(LOCAL_USER_ID, { includeClosed: true });
    assert.equal(snapshot.kind, 'snapshot');
    if (snapshot.kind !== 'snapshot')
        throw Error('snapshot');
    assert.equal(snapshot.works.length, 24);
    db.connection.prepare("UPDATE works SET state_version=state_version+1 WHERE work_id='bulk-0010'").run();
    const delta = journal.sync(LOCAL_USER_ID, { includeClosed: true, cursor: snapshot.cursor });
    assert.equal(delta.kind, 'delta');
    if (delta.kind === 'delta')
        assert.ok(delta.events.every(e => e.kind === 'remove' || e.projection.listSummary));
    console.log('PASS compact SQL summary pagination: 2501 rows, Unicode full-goal search, page clamps, owner isolation, status parity, sort mutation, bounded journal bootstrap/deltas');
}
finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
}
