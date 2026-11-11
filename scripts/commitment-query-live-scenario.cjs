/** Real foreground model/renderer queries against explicit isolated Work fixtures, not fake tool results. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Verify machine-readable task codes separately from fluent exclusion wording.
// An excluded code must both exist in real non-waiting tool facts and be stated
// negatively in its own sentence; fabricated codes can never use this exception.
function verifyAnswerCodes(key, answer, expected, queries) {
  const prefixes={overdue:'RELEASE',today:'STOCK',dst:'CONFIG',waiting:'CONTRACT',priority:'ERROR',paged:'SHIP'};
  const expectedCodes=expected.map(item=>item.title.split(' ').at(-1));
  const answerCodes=[...new Set(answer.match(new RegExp(prefixes[key]+'-[A-Z0-9]+(?:-[A-Z0-9]+)*','g'))||[])];
  const excluded=key==='waiting' ? new Set(queries.flatMap(q=>(q.result?.items||[])
    .filter(item=>item.needsUserInput===false).map(item=>item.title.split(' ').at(-1)))) : new Set();
  for(const code of answerCodes.filter(code=>excluded.has(code)))
    assert(answer.split(/[。；\n]/).some(sentence=>sentence.includes(code)&&/排除|解除|不属于|不是|不涉及|不再算|不需要|无未解决|纯外部故障/.test(sentence)), 'extra code is only an explicit exclusion: '+code);
  assert.deepEqual(answerCodes.filter(code=>!excluded.has(code)).sort(),expectedCodes.sort(), 'final answer has no missing or invented codes');
  if(key==='paged') assert(/(?:共(?:有|计)?|总(?:计|数)|合计|一共|数量)\s*(?:为|是|：|:)?\s*(?:23|二十三)(?:\s*(?:条|项|个)|(?=[。；，,\n]|$))/.test(answer.replace(/\*/g,'').replace(/SHIP-[A-Z0-9]+(?:-[A-Z0-9]+)*/g,'')), 'final answer independently states the correct total');
}
exports.verifyAnswerCodes=verifyAnswerCodes;

exports.run = async ({send,foregroundDone,evaluate,history,report,requests,agentDir,out,botId}) => {
  const db = new (require('better-sqlite3'))(path.join(agentDir, 'app.db'));
  db.pragma('busy_timeout=10000');
  const now = Date.now(), day = 86400000;
  const shanghaiStart = Math.floor((now + 8*3600000)/day)*day - 8*3600000;
  const shanghaiEnd = shanghaiStart + day;
  const dstFrom = Date.parse('2027-03-14T05:00:00Z'), dstBefore = Date.parse('2027-03-15T04:00:00Z');
  let serial = 0;
  const insert = db.prepare(`INSERT INTO works (work_id,user_id,owner_bot_id,title,goal_description,authorization_json,
    active_intent_snapshot_id,input_snapshot_id,mode,lifecycle,created_by,created_at,updated_at,deadline_at)
    VALUES (@id,@userId,@botId,@title,@title,'["workspace:read"]',@snapshot,'snapshot:unbound','once',@status,'user',@created,@created,@deadline)`);
  const seed = (title, deadline, options = {}) => {
    const id = 'query-fixture-' + ++serial;
    insert.run({id, userId:options.foreign ? 'another-user' : 'user-local-primary', botId, title,
      snapshot:'snapshot-'+id,status:options.closed ? 'closed' : 'paused', created:options.newer ? now+serial : now-day*30+serial,deadline:deadline ?? null});
    db.prepare(`INSERT INTO work_intent_snapshots (snapshot_id,work_id,intent_revision,source_version,title,goal_description,
      constraints_json,criteria_json,authorization_json,expert_snapshot_json,input_snapshot_id,goal_sources_json,created_by,created_at)
      VALUES (?, ?, 1, 1, ?, ?, '[]','[]','["workspace:read"]','{}','snapshot:unbound','[]','user',?)`)
      .run('snapshot-'+id,id,title,title,now);
    if (deadline != null) db.prepare(`INSERT INTO work_deadline_instances(work_id,deadline_revision,deadline_at,state,created_at,followed_at)
      VALUES (?,1,?,'followed-up',?,?)`).run(id,deadline,now,now);
    if (options.waiting !== undefined) db.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,waiting_for_user_input,status,created_at)
      VALUES (?, ?, ?, 'operational', ?, ?, ?)`).run('block-'+id,id,options.reason || '请确认范围',options.waiting ? 1 : 0,options.cleared ? 'cleared' : 'open',now);
    return {id,title,deadline};
  };
  const expected = {};
  db.transaction(() => {
    expected.overdue = [seed('发布承诺 RELEASE-A',now-day*2),seed('发布承诺 RELEASE-B',now-day)];
    seed('发布承诺 RELEASE-CLOSED',now-day,{closed:true});seed('发布承诺 RELEASE-FOREIGN',now-day,{foreign:true});
    for(let i=0;i<25;i++) seed('发布承诺 FUTURE-'+i,now+day*10+i,{newer:true});
    expected.today = [seed('库存核查 STOCK-TODAY',shanghaiEnd-1)];
    seed('库存核查 STOCK-YESTERDAY',shanghaiStart-1);seed('库存核查 STOCK-TOMORROW',shanghaiEnd);
    for(let i=0;i<25;i++) seed('库存核查 STOCK-LATER-'+i,shanghaiEnd+day*3+i,{newer:true});
    expected.dst = [seed('配置审计 CONFIG-DST',dstFrom+12*3600000)];
    seed('配置审计 CONFIG-BEFORE',dstFrom-1);seed('配置审计 CONFIG-AFTER',dstBefore);
    expected.waiting = [seed('合同对比 CONTRACT-ASK',null,{waiting:true,reason:'请提供最终采购数量'})];
    seed('合同对比 CONTRACT-CLEARED',null,{waiting:true,cleared:true});seed('合同对比 CONTRACT-SERVICE',null,{waiting:false,reason:'外部服务维护'});
    for(let i=0;i<25;i++) seed('合同对比 CONTRACT-RECENT-'+i,null,{newer:true});
    expected.priority = [seed('日志排障 ERROR-A',now-day*3),seed('日志排障 ERROR-B',now-day),seed('日志排障 ERROR-C',now+day)];
    seed('日志排障 ERROR-UNDATED',null,{newer:true});
    for(let i=0;i<25;i++) seed('日志排障 ERROR-LATER-'+i,now+day*10+i,{newer:true});
    expected.paged = Array.from({length:23},(_,i)=>seed('运单核对 SHIP-'+String(i+1).padStart(3,'0'),shanghaiStart+i*1000));
    for(let i=0;i<25;i++) seed('运单核对 SHIP-LATER-'+i,shanghaiEnd+day*3+i,{newer:true});
  })();
  const initial = db.prepare('SELECT count(*) n FROM works').get().n;
  const cases = [
    {key:'overdue',name:'发布承诺逾期清点',prompt:'查一下发布承诺中已经过期但还没结束的有哪些，按承诺期限先后列出。',check:q=>q.deadlineBefore >= now-300000 && q.deadlineBefore <= Date.now()+300000 && q.sort==='deadline_asc'},
    {key:'today',name:'上海今日库存承诺',prompt:'按 Asia/Shanghai 时区，只列今天当天到期但未结束的库存核查承诺，不含昨日或明日。',check:q=>q.deadlineFrom===shanghaiStart&&q.deadlineBefore===shanghaiEnd&&q.sort==='deadline_asc'},
    {key:'dst',name:'纽约夏令时配置审计',prompt:'按 America/New_York 时区，列出2027年3月14日当天到期且未结束的配置审计承诺，注意本地日期边界。',check:q=>q.deadlineFrom===dstFrom&&q.deadlineBefore===dstBefore&&q.sort==='deadline_asc'},
    {key:'waiting',name:'合同待用户输入',prompt:'哪些合同对比事项还在等我提供信息？把问题也列出来，已解决的和纯外部服务故障不要列。',check:q=>q.needsUserInput===true},
    {key:'priority',name:'日志排障期限优先级',prompt:'未结束的日志排障承诺，按期限从早到晚只列最靠前的3项，不要按创建时间选，也不要优先没填期限的。',check:q=>q.sort==='deadline_asc'&&q.limit===3},
    {key:'paged',name:'运单承诺跨页盘点',prompt:'按 Asia/Shanghai 时区，查今天结束之前到期的所有未结束运单核对承诺。每次最多查10项，完整翻页后告诉我总数并列出全部运单代号，不要只看首页。',check:q=>q.deadlineBefore===shanghaiEnd&&q.limit===10&&q.sort==='deadline_asc'},
  ];
  const callIds = () => new Set(requests.flatMap(r=>r.messages.flatMap(m=>m.role==='assistant' ? (m.tool_calls||[]).map(t=>t.id) : [])));
  report.scenarios=[];
  fs.writeFileSync(path.join(out,'progress.json'),'[]');
  try {
    for(const c of cases){
      try {
      const seen = callIds(), requestStart=requests.length;
      await send(c.prompt+' 仅查询现有记录，不创建、恢复、修改或执行任何事项。');
      await foregroundDone();
      const h=await history(), user=h.messages.filter(m=>m.role==='user').at(-1);
      const answer=h.messages.find(m=>m.role==='assistant'&&m.requestId===user.requestId&&m.status==='completed').text;
      const calls = new Map(), results = new Map();
      for(const r of requests.slice(requestStart)) for(const m of r.messages){
        if(m.role==='assistant') for(const t of m.tool_calls||[]) if(!seen.has(t.id)) calls.set(t.id,t);
        if(m.role==='tool'&&!seen.has(m.tool_call_id)) {try{results.set(m.tool_call_id,JSON.parse(typeof m.content==='string'?m.content:JSON.stringify(m.content)));}catch{results.set(m.tool_call_id,{error:typeof m.content==='string'?m.content:JSON.stringify(m.content)});}}
      }
      const queries=[...calls].filter(([,t])=>t.function.name==='work_query_status').map(([id,t])=>({id,args:JSON.parse(t.function.arguments),result:results.get(id)}));
      const matching=queries.filter(q=>c.check(q.args));
      // A model may legitimately inspect a broader page before narrowing its search.
      // Verify the targeted pages, not the union of preliminary and final searches.
      const selected=matching.some(q=>q.args.search) ? matching.filter(q=>q.args.search) : matching;
      const successful=selected.filter(q=>Array.isArray(q.result?.items));
      const subjects={overdue:'发布承诺',today:'库存核查',dst:'配置审计',waiting:'合同对比',priority:'日志排障',paged:'运单核对'};
      const ids=new Set(successful.flatMap(q=>q.result.items.filter(item=>item.title.includes(subjects[c.key])).map(item=>item.workId)));
      const observation={name:c.name,prompt:c.prompt,answer,queries,expected:expected[c.key],passed:false};
      report.scenarios.push(observation);fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(report.scenarios,null,2));
      // Reading a complete broader time window is valid too. Never accept a
      // partial broad first page as proof that all matching commitments were found.
      if(c.key!=='priority') for(const q of successful) if(q.result.hasMore)
        assert(successful.some(next=>next.args.cursor===q.result.nextCursor), 'all relevant query pages must be consumed');
      assert(selected.length,'model chose bounded query filters for '+c.name);
      assert.deepEqual([...ids].sort(),expected[c.key].map(item=>item.id).sort(),'actual tool facts match exactly: '+c.name);
      for(const item of expected[c.key]) assert(answer.includes(item.title.split(' ').at(-1)), 'final answer includes '+item.title);
      verifyAnswerCodes(c.key,answer,expected[c.key],queries);
      if(c.key==='waiting') assert(answer.includes('采购数量'),answer);
      if(c.key==='priority') assert(answer.indexOf('ERROR-A')<answer.indexOf('ERROR-B')&&answer.indexOf('ERROR-B')<answer.indexOf('ERROR-C'));
      if(c.key==='paged') {assert(successful.some(q=>q.args.cursor),'model follows real nextQuery');assert(successful.every(q=>q.result.total>=23));}
      for(const [id,t] of calls) assert.equal(t.function.name,'work_query_status','query must not mutate/create '+id);
      observation.recoveredQueryErrors=queries.filter(q=>q.result?.error).map(q=>q.result.error);
      observation.passed=true;fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(report.scenarios,null,2));
      } catch(error) {
        const observation=report.scenarios.find(item=>item.name===c.name)||{name:c.name,prompt:c.prompt,passed:false};
        observation.error=String(error.stack||error);
        if(!report.scenarios.includes(observation)) report.scenarios.push(observation);
        fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(report.scenarios,null,2));
      }
    }
    assert.equal(report.scenarios.length,6);
    assert.equal(db.prepare('SELECT count(*) n FROM works').get().n,initial);
    assert.equal(db.prepare('SELECT count(*) n FROM work_execution_bindings').get().n,0);
    report.checks.push('six actual-model daily review intents across release, inventory, configuration/DST, contract input, log priority and shipment pagination; exact real SQLite facts; no new Work or execution');
    report.history=await history();
    assert(report.scenarios.every(item=>item.passed),report.scenarios.filter(item=>!item.passed).map(item=>item.name+': '+item.error).join('\n'));
    report.source='Explicit paused Work fixtures in isolated HOME; validates natural-language queries, not natural-language task creation or execution.';
  } finally {db.close();}
};
