/** Paired synthetic benchmark for the real Work detail projection. No user data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from '../src/shared/bot-work';

const baselinePath = process.env.PARTIAL_BASELINE_MODULE;
if (!baselinePath) throw Error('Run through scripts/perf-work-partial.mjs');
const { WorkPartialResults: Baseline } = await import(pathToFileURL(baselinePath).href);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results: unknown[] = [];
const scenarios = [{ n: 20, bindings: 1, plans: false }, { n: 100, bindings: 1, plans: false },
  { n: 1000, bindings: 1, plans: false }, { n: 1000, bindings: 20, plans: false },
  { n: 100, bindings: 5, plans: true }];
for (const scenario of scenarios) {
  const { n } = scenario;
  const db = new AppDatabase(join(process.env.HOME!, `partial-${n}-${scenario.bindings}-${scenario.plans}.db`));
  try {
    const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
    const works = new WorkService(db.connection, { bots });
    const user = { kind: 'user' as const, userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
    const created = works.createWork(user, { operationId: 'create', title: 'Accumulated unresolved research checks',
      ownerBotId: DEFAULT_BOT_ID, inputSnapshotId: 'fixture-input', authorization: DESKTOP_USER_GRANTS });
    if (!created.ok) throw Error(created.message);
    const work = created.work;
    const dispatched = works.dispatchExecution(user, { operationId: 'dispatch', workId: work.workId, botId: DEFAULT_BOT_ID,
      taskId: 'fixture-task', durableStoreKey: 'fixture', conversationId: '1', workspaceBinding: '/fixture' });
    if (!dispatched.ok) throw Error(dispatched.message);
    const first = works.repo.getBinding(dispatched.work.activeExecutionIds[0])!;
    works.repo.updateBinding({ ...first, status: 'failed' });
    const bindings = [first];
    const insert = db.connection.prepare('INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at) VALUES (?,?,?,?,?,?)');
    db.connection.transaction(() => {
      for (let i = 1; i < scenario.bindings; i++) {
        const binding = { ...first, bindingId: `binding:${i}`, operationId: `operation:${i}`, taskId: `task:${i}`, status: 'failed' as const };
        works.repo.insertBinding(binding); bindings.push(binding);
      }
      for (let i = 0; i < n; i++) insert.run(`fact:${i}`, work.workId, bindings[i % bindings.length].bindingId, `item:${i}`,
        JSON.stringify({ itemId: `item:${i}`, task: `Read and compare item ${i}`, required: true, dependencies: [], criterionIds: [],
          nativeStatus: 'failed', outcome: 'failed', artifactRefs: [], writeConflicts: [], summary: 'Read failed; pending retry' }), i + 1);
      if (scenario.plans) for (const [i, source] of bindings.entries()) {
        const target = { ...source, bindingId: `retry:${i}`, operationId: `retry:${i}`, taskId: `retry-task:${i}`, status: 'failed' as const };
        works.repo.insertBinding(target);
        const ids = Array.from({ length: n }, (_, index) => index).filter(index => index % bindings.length === i).map(index => `item:${index}`);
        db.connection.prepare(`INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,input_snapshot_id,owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`plan:${i}`, work.workId, source.bindingId, `plan:${i}`, work.intentRevision, work.inputSnapshotId,
          work.ownerEpoch, work.ownerBotId, JSON.stringify(ids), 'Retry remaining checks', 'dispatched', i + n);
        db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(`retry:${i}`, work.workId, target.taskId, target.botId, work.intentRevision, work.inputSnapshotId, 'dispatched', n + i, `plan:${i}`);
      }
    })();
    const candidatePrototype = Object.getPrototypeOf(works.partialResults);
    const project = (variant: 'baseline' | 'candidate') => {
      // The shared partial-results instance is also held by WorkMilestones. Switch
      // only its implementation, preserving the same DB, WorkService and facts.
      Object.setPrototypeOf(works.partialResults, variant === 'baseline' ? Baseline.prototype : candidatePrototype);
      return works.getProjection(work.workId);
    };
    const expected = project('baseline'); assert.deepEqual(project('candidate'), expected);
    for (let i = 0; i < 2; i++) { project('baseline'); project('candidate'); }
    const samples: Array<{ pair: number; variant: 'baseline' | 'candidate'; wallMs: number; cpuMs: number; timerLagMs: number; heapDeltaMiB: number }> = [];
    for (let pair = 0; pair < 6; pair++) for (const variant of (pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) as Array<'baseline' | 'candidate'>) {
      const cpu = process.cpuUsage(), memory = process.memoryUsage().heapUsed, start = performance.now();
      let timerLagMs = 0;
      const timer = new Promise<void>(resolve => setTimeout(() => { timerLagMs = performance.now() - start; resolve(); }, 0));
      const value = project(variant); const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
      const heapDeltaMiB = (process.memoryUsage().heapUsed - memory) / 1048576;
      await timer;
      assert.deepEqual(value, expected);
      samples.push({ pair, variant, wallMs, cpuMs: (used.user + used.system) / 1000, timerLagMs, heapDeltaMiB });
    }
    const queryCounts: Record<string, Record<string, number>> = {};
    const prepare = db.connection.prepare.bind(db.connection);
    for (const variant of ['baseline', 'candidate'] as const) {
      const counts: Record<string, number> = {};
      db.connection.prepare = ((sql: string) => { counts[sql] = (counts[sql] ?? 0) + 1; return prepare(sql); }) as typeof db.connection.prepare;
      try { assert.deepEqual(project(variant), expected); } finally { db.connection.prepare = prepare; }
      queryCounts[variant] = counts;
    }
    const summary = Object.fromEntries((['baseline', 'candidate'] as const).map(variant => {
      const selected = samples.filter(row => row.variant === variant);
      return [variant, { wallMedianMs: median(selected.map(row => row.wallMs)), wallMaxMs: Math.max(...selected.map(row => row.wallMs)),
        cpuMedianMs: median(selected.map(row => row.cpuMs)), timerMedianMs: median(selected.map(row => row.timerLagMs)),
        prepares: Object.values(queryCounts[variant]).reduce((sum, n) => sum + n, 0) }];
    }));
    const result = { scenario, completeDtoParityChecks: 15, digest: digest(expected), summary, samples, queryCounts };
    results.push(result); console.log(JSON.stringify({ scenario, summary }));
  } finally { db.close(); }
}
writeFileSync(process.argv[2], JSON.stringify({ synthetic: true, backendOnly: true, node: process.version, results }, null, 2));
