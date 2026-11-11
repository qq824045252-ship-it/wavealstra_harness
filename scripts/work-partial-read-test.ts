import assert from 'node:assert/strict';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkExecutionBindingDto } from '../src/shared/bot-work';
import type { WorkSubitemResult } from '../src/shared/bot-work-phase3';

const db = new AppDatabase(':memory:');
const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
const works = new WorkService(db.connection, { bots });
const user = { kind: 'user' as const, userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const result = works.createWork(user, { operationId: 'partial-read', title: 'Read scope', authorization: DESKTOP_USER_GRANTS, inputSnapshotId: 'fixture-input' });
if (!result.ok) throw Error(result.message);
const work = result.work;
const dispatched = works.dispatchExecution(user, { operationId: 'root', workId: work.workId, botId: DEFAULT_BOT_ID,
  taskId: 'root-task', durableStoreKey: 'fixture', conversationId: '1', workspaceBinding: '/fixture' });
if (!dispatched.ok) throw Error(dispatched.message);
const root = works.repo.getBinding(dispatched.work.activeExecutionIds[0])!;
const binding = (id: string, status: WorkExecutionBindingDto['status'] = 'failed') => {
  const value = { ...root, bindingId: id, operationId: id, taskId: `${id}-task`, status };
  works.repo.insertBinding(value); return value;
};
const item = (owner: WorkExecutionBindingDto, id: string, outcome: WorkSubitemResult['outcome'], options: Partial<WorkSubitemResult> = {}) => {
  const value: WorkSubitemResult = { itemId: id, task: `Task ${id}`, required: true, dependencies: [], criterionIds: [], nativeStatus: outcome,
    outcome, artifactRefs: [], writeConflicts: [], summary: `Result ${id}`, ...options };
  db.connection.prepare('INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(`${owner.bindingId}:${id}`, work.workId, owner.bindingId, id, JSON.stringify(value), 1);
};
const plan = (id: string, source: WorkExecutionBindingDto, target: WorkExecutionBindingDto, ids: string[], state = 'dispatched') => {
  db.connection.prepare(`INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,input_snapshot_id,owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, work.workId, source.bindingId, id, work.intentRevision, work.inputSnapshotId, work.ownerEpoch, work.ownerBotId, JSON.stringify(ids), 'Retry missing facts', state, 2);
  db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id)
    VALUES (?,?,?,?,?,?,?,2,?)`).run(id, work.workId, target.taskId, target.botId, work.intentRevision, work.inputSnapshotId, 'dispatched', id);
};
function traced<T>(fn: () => T) {
  const prepare = db.connection.prepare.bind(db.connection), calls: Record<string, number> = {};
  db.connection.prepare = ((sql: string) => { calls[sql] = (calls[sql] ?? 0) + 1; return prepare(sql); }) as typeof db.connection.prepare;
  try { return { value: fn(), calls }; } finally { db.connection.prepare = prepare; }
}
const count = (calls: Record<string, number>, fragment: string) => Object.entries(calls).filter(([sql]) => sql.includes(fragment)).reduce((sum, [, n]) => sum + n, 0);
const rootGaps = () => works.partialResults.gaps(work.workId).filter(row => row.bindingId === root.bindingId).map(row => row.itemId);
try {
  db.connection.transaction(() => { for (let i = 0; i < 120; i++) item(root, `item-${i}`, 'failed'); })();
  let read = traced(() => works.partialResults.list(work.workId));
  assert.equal(read.value.length, 120);
  assert.equal(count(read.calls, 'FROM work_execution_bindings WHERE binding_id='), 1, 'one binding read, not one per subitem');
  const gaps = traced(() => works.partialResults.gaps(work.workId));
  assert.deepEqual(gaps.value, read.value);
  assert.equal(count(gaps.calls, 'FROM work_execution_bindings WHERE binding_id='), 1);
  assert.equal(count(gaps.calls, 'FROM work_continuation_plans'), 1, 'one empty-plan query per read');
  assert.equal(count(gaps.calls, 'FROM work_subitem_results'), 1);

  // One retry plan covers many gaps. Match by exact item identity or existing task fallback.
  const child = binding('child', 'completed');
  item(child, 'item-0', 'completed');
  item(child, 'renamed', 'completed', { task: 'Task item-1' });
  item(child, 'item-2', 'failed');
  plan('first-plan', root, child, Array.from({ length: 120 }, (_, i) => `item-${i}`));
  const continued = traced(() => works.partialResults.gaps(work.workId));
  assert.equal(continued.value.filter(row => row.bindingId === root.bindingId).length, 118);
  assert.equal(count(continued.calls, 'FROM work_continuation_plans'), 1);
  assert.equal(count(continued.calls, 'FROM work_subitem_results'), 1);
  assert.equal(count(continued.calls, 'FROM work_dispatch_requests WHERE continuation_plan_id='), 1);
  assert.equal(count(continued.calls, 'FROM work_execution_bindings WHERE task_id='), 1);
  assert.deepEqual(rootGaps().slice(0, 3), ['item-2', 'item-3', 'item-4']);

  // Multi-hop resolution stays visible even when the first retry never emitted that item.
  const grandchild = binding('grandchild', 'completed');
  item(grandchild, 'item-2', 'completed');
  plan('second-plan', child, grandchild, ['item-2']);
  assert.equal(rootGaps().includes('item-2'), false);
  const loop = binding('loop', 'failed');
  plan('third-plan', grandchild, loop, ['item-3']);
  // A dispatched loop returns to root, then revisits first-plan. A separate
  // matching descendant remains successful; cycle state is not shared by items.
  works.repo.updateBinding({ ...root, status: 'failed' });
  plan('loop-plan', loop, root, ['item-3']);
  assert.equal(rootGaps().includes('item-3'), true);
  assert.equal(rootGaps().includes('item-2'), false);

  // New calls see current rows and dispatch status, including within a rollback.
  works.repo.updateBinding({ ...child, status: 'running' });
  assert.equal(rootGaps().includes('item-0'), true);
  works.repo.updateBinding(child);
  assert.equal(rootGaps().includes('item-0'), false);
  assert.throws(() => db.connection.transaction(() => {
    db.connection.prepare("UPDATE work_dispatch_requests SET state='cancelled' WHERE continuation_plan_id='first-plan'").run();
    assert.equal(rootGaps().includes('item-0'), true);
    throw Error('rollback');
  })(), /rollback/);
  assert.equal(rootGaps().includes('item-0'), false, 'rolled back dispatch change is not retained');
  item(child, 'item-4', 'completed');
  assert.equal(rootGaps().includes('item-4'), false, 'new settlement is not hidden');

  const currentWork = works.getWork(work.workId)!;
  db.connection.prepare('UPDATE works SET intent_revision=intent_revision+1 WHERE work_id=?').run(work.workId);
  assert.deepEqual(works.partialResults.gaps(work.workId), [], 'historical intent is not a current gap');
  db.connection.prepare('UPDATE works SET intent_revision=? WHERE work_id=?').run(currentWork.intentRevision, work.workId);
  assert(rootGaps().length > 0);
  db.connection.prepare('UPDATE works SET owner_epoch=owner_epoch+1 WHERE work_id=?').run(work.workId);
  assert.deepEqual(works.partialResults.gaps(work.workId), [], 'unadopted prior-owner bindings stay excluded');
  db.connection.prepare('UPDATE works SET owner_epoch=? WHERE work_id=?').run(currentWork.ownerEpoch, work.workId);
  assert(rootGaps().length > 0);
  assert.deepEqual(works.partialResults.gaps('missing-work'), []);
  const getBinding = works.repo.getBinding.bind(works.repo);
  works.repo.getBinding = () => undefined;
  assert.throws(() => works.partialResults.list(work.workId), /逐项事实缺少原执行绑定/);
  works.repo.getBinding = getBinding;
  const original = db.connection.prepare('SELECT result_json FROM work_subitem_results WHERE fact_id=?').get(`${root.bindingId}:item-0`) as { result_json: string };
  db.connection.prepare('UPDATE work_subitem_results SET result_json=? WHERE fact_id=?').run('{}', `${root.bindingId}:item-0`);
  assert.throws(() => works.partialResults.list(work.workId));
  db.connection.prepare('UPDATE work_subitem_results SET result_json=? WHERE fact_id=?').run(original.result_json, `${root.bindingId}:item-0`);
  db.connection.prepare("UPDATE work_continuation_plans SET gap_items_json='{}' WHERE plan_id='first-plan'").run();
  assert.throws(() => works.partialResults.gaps(work.workId), 'invalid eligible plans still fail validation');
  db.connection.prepare('UPDATE works SET intent_revision=intent_revision+1 WHERE work_id=?').run(work.workId);
  assert.deepEqual(works.partialResults.gaps(work.workId), [], 'plans remain lazy when no current gaps are eligible');
  console.log('PASS partial reads: distinct-binding SQL, shared and multi-hop continuations, cycles, settlement freshness, rollback, intent and owner scope');
} finally { db.close(); }
