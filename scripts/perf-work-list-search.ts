/** Synthetic fixture shared by the isolated query benchmark and Electron IPC check. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService } from '../src/main/agent/work/WorkService';
import { WorkListQuery } from '../src/main/agent/work/WorkListQuery';
import { LOCAL_USER_ID, DEFAULT_BOT_ID } from '../src/shared/bot-work';
import type { WorkQueryRequest } from '../src/shared/bot-work-query';
export function fixture(path: string, n = 50000) {
  const app = new AppDatabase(path), db = app.connection;
  const bots = new BotRegistry(db); bots.ensureDefaultBot(LOCAL_USER_ID); new WorkService(db, {bots});
  const query = new WorkListQuery(db);
  const insert = db.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,title,goal_description,lifecycle,closure_conclusion,
    authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'[]','fixture','snapshot:unbound','user',?,?)`);
  const detail = db.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,
    input_snapshot_id,status,summary,artifact_refs_json,created_at) VALUES (?,?,?,'fixture',1,1,'snapshot:unbound','proposed',?,'["/synthetic/report.csv"]',1)`);
  db.transaction(() => {
    for (let i=0;i<n;i++) {
      const id = `work-${String(i).padStart(5,'0')}`, bucket = i % 5;
      insert.run(id,LOCAL_USER_ID,DEFAULT_BOT_ID,`Synthetic work ${i}`, i % 100 === 0 ? 'ＡＢＣ cafe\u0301 细节' : '',
        bucket === 0 ? 'paused' : bucket < 3 ? 'closed' : 'active', bucket === 1 ? 'succeeded' : bucket === 2 ? 'cancelled' : null,i+1,i+1);
      if (i % 200 === 0) detail.run(`report-${i}`,id,DEFAULT_BOT_ID,'Long report content. '.repeat(1000)+'DeepReportTail');
    }
  })();
  return { app, db, query, read: (request: WorkQueryRequest) => query.query(LOCAL_USER_ID,request) };
}
export function run(path: string, output: string) {
  const f = fixture(path);
  const common = {scope:{kind:'all'},view:'all'} as const;
  const cases: Array<[string, WorkQueryRequest]> = [
    ['unfiltered',common], ['title-all',{...common,query:'Synthetic'}],
    ['title-rare',{...common,query:'Synthetic 49999'}], ['goal-unicode',{...common,query:'abc CAFÉ 细节'}],
    ['detail-tail',{...common,query:'DeepReportTail'}], ['mixed-title-detail',{...common,query:'Synthetic DeepReportTail report.csv'}],
    ['derived-guidance',{...common,query:'安排后台执行'}], ['no-match',{...common,query:'NoSuchTerm_测试'}],
    ['paused-page3',{...common,query:'Synthetic',status:'paused',page:3,pageSize:17,sort:'oldest'}],
    ['closed-page-clamp',{...common,view:'closed',query:'Synthetic',page:999999}],
  ];
  try {
    const measure = ([name,request]: [string, WorkQueryRequest]) => {
      const cold = () => f.db.transaction(() => f.read(request))();
      const firstStart=performance.now(),reference = cold(),firstQueryMs=performance.now()-firstStart;
      const {watermark: _watermark,...payload} = reference;
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const samples: number[] = [];
      for(let i=0;i<7;i++) { const start=performance.now(); const actual=cold(); samples.push(performance.now()-start); assert.deepEqual({...actual,watermark:undefined},{...reference,watermark:undefined}); }
      samples.sort((a,b)=>a-b);
      f.read(request); const start=performance.now();f.read(request);const cachedMs=performance.now()-start;
      const row={name,request,firstQueryMs,medianMs:samples[3],p95Ms:samples[6],cachedMs,filtered:reference.filtered,pages:reference.pages,
        page:reference.page,statusCounts:reference.filterCounts,digest};
      console.log(JSON.stringify(row)); return row;
    };
    const results = cases.map(measure);
    f.db.prepare('UPDATE work_deliverables SET summary=?').run('Long report content. '.repeat(6000)+'DeepReportTail');
    results.push(measure(['long-report-tail',{...common,query:'DeepReportTail'}]));
    const ids: string[]=[];
    // Walk every page of the mixed full-text result, with both sorting directions.
    for(const sort of ['oldest','recent'] as const) {
      const collected:string[]=[];
      for(let page=1;page<=15;page++) {
        const result=f.read({...common,query:'Synthetic DeepReportTail',sort,page,pageSize:17});
        collected.push(...result.works.map(work=>work.workId));
        if(page===result.pages)break;
      }
      assert.equal(new Set(collected).size,250); assert.equal(collected.length,250);
      if(sort==='oldest')ids.push(...collected);else assert.deepEqual(collected,ids.toReversed());
    }
    writeFileSync(output,JSON.stringify({node:process.version,fixtureRows:50000,samplesPerCase:7,results,pagination:'250 distinct full-text matches, every page, both sorts'},null,2));
  } finally { f.app.close(); }
}
if(process.argv[2]==='--run') run(process.argv[3],process.argv[4]);
