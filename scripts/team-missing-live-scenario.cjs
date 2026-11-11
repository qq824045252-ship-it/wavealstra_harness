/** Real online model, real file tools, isolated two-member teams; no reply substitution. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
exports.run = async ({send,foregroundDone,until,evaluate,history,report,requests,agentDir,out,home,modelKey,botId}) => {
  const partial = process.argv.includes('--team-missing-partial');
  const seed = crypto.randomBytes(6).toString('hex');
  const cases = [
    {type:'csv', input:'name,units\nA,2\nB,3\n', a:'rows.csv', av:'name,units\nA,2\nB,3\n', b:'total.txt', bv:'5\n', goal:'复制 CSV 到 rows.csv，并把 units 合计 5 写入 total.txt'},
    {type:'json', input:'{"first":"Ada","last":"Lovelace"}\n', a:'person.json', av:'{"name":"Ada Lovelace"}\n', b:'initials.json', bv:'{"initials":"AL"}\n', goal:'把 JSON 转换成 person.json 的 name 和 initials.json 的 initials'},
    {type:'report', input:'Finding: access is read-only.\n', a:'report.md', av:'# Report\nAccess is read-only.\n', b:'appendix.md', bv:'# Appendix\nSource: evidence.txt\n', goal:'生成 report.md 报告和 appendix.md 来源附录'},
    {type:'code', input:'Implement add(a,b), and test add(2,3) equals 5.\n', a:'add.cjs', av:'module.exports = (a, b) => a + b;\n', b:'add.test.cjs', bv:"require('node:assert/strict').equal(require('./add.cjs')(2, 3), 5);\n", goal:'生成 add.cjs 加法实现和 add.test.cjs Node 断言测试'},
    {type:'translation', input:'Hello.\nThank you.\n', a:'first.txt', av:'你好。\n', b:'second.txt', bv:'谢谢。\n', goal:'将两段英文分别翻译成 first.txt 和 second.txt'},
    {type:'manifest', input:'alpha\nbeta\n', a:'alpha.txt', av:'alpha\n', b:'beta.txt', bv:'beta\n', goal:'拆分输入为 alpha.txt 和 beta.txt 两个输出文件'},
  ];
  report.teamMissing = {partial, cases:[], seed};
  const api = (name,arg) => evaluate(`window.api.botWork.${name}(${JSON.stringify(arg)})`);
  const owner=(await api('listBots')).find(b=>b.botId===botId);
  assert((await api('updateWorkspaceAuthorization',{botId,expectedUpdatedAt:owner.updatedAt,allowWorkspaceFiles:true,confirmNewWorksOnly:true})).ok);
  // Private prompt belongs only to an unselected bot, never in a shared template or user request.
  const privateMarker='UNSELECTED_PRIVATE_'+seed;
  const outsider=await api('createBot',{requestId:crypto.randomUUID(),displayName:'无关图片设计师',responsibilitySummary:'仅负责图片设计'});assert(outsider.ok);
  const outsiderSettings=(await api('getSettings',outsider.bot.botId)).settings;
  // saveSettings has no private-prompt field; use a private workspace file as an explicit no-read sentinel.
  const privateDir=path.join(home,'unselected-private');fs.mkdirSync(privateDir);fs.writeFileSync(path.join(privateDir,'private.txt'),privateMarker);
  assert((await api('saveSettings',{botId:outsider.bot.botId,expectedRevision:outsiderSettings.revision,workspacePath:privateDir,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})).ok);
  for (const [index,c] of cases.entries()) {
    const result={type:c.type,status:'running'};report.teamMissing.cases.push(result);
    const workspace=path.join(home,`${partial?'partial':'normal'}-${c.type}`);fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'evidence.txt'),c.input);
    const settings=(await api('getSettings',botId)).settings;
    assert((await api('saveSettings',{botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})).ok);
    const members=[];
    for(const name of ['执行员','独立核验员']) {const m=await api('createBot',{requestId:crypto.randomUUID(),displayName:`${c.type}${name}`,responsibilitySummary:name});assert(m.ok);members.push(m.bot.botId);}
    const exact=`读取 ${path.join(workspace,'evidence.txt')}；${c.goal}。输出必须字节完全匹配：${c.a} = ${JSON.stringify(c.av)}；${c.b} = ${JSON.stringify(c.bv)}。执行员写入须用 write 工具，并用 read 回读；允许只读字节校验，负责人可以只读核对但不得写入，最终简短报告文件与缺项。`;
    const responsibility=exact+(partial?` 两阶段故障夹具：首次执行只写 ${c.a}，不能写 ${c.b}，然后如实报告“缺少 ${c.b}，尚未写入，需原成员补做”，并结束本轮。仅当 recovery.failureClass=semantic_missing 时回读已有 ${c.a} 并保留，不再写它，只创建缺少的 ${c.b} 并回读。`:'');
    const templateName=`${partial?'补缺':'正常'}-${c.type}-${seed}`;
    const siblingFile=path.join(workspace,'checked.txt'),siblingValue='CHECKED_'+seed+'_'+c.type+'\n';
    assert((await api('teamControl',{kind:'save_template',request:{operationId:'template-'+index+'-'+seed,name:templateName,plan:{workspacePath:workspace,ownerBotId:botId,ownerResponsibility:'只读汇总各成员真实成果；逐项说明缺失输出，不代替成员写入，不把缺项说成完成。',executionPolicy:'parallel',maxConcurrency:2,members:[{botId:members[0],responsibility,delegatedScope:['workspace:read','workspace:write']},{botId:members[1],responsibility:`读取 evidence.txt，然后只写 ${siblingFile}，内容精确为 ${JSON.stringify(siblingValue)}，必须用 write 写入和 read 回读；允许只读校验，最终两句报告。不得修改其他成员输出。`,delegatedScope:['workspace:read','workspace:write']}]}}})).ok);
    const start=requests.length;
    await send(`请使用已保存的“${templateName}”团队，严格保留模板分工。实际目标：${exact} 同时由独立核验员完成 checked.txt。全部文件都需要交付，任何缺项由原执行成员补齐，不扩大负责人权限，不重复已完成写入，不另建 Work，不再询问批准。现在开始。`);await foregroundDone();
    let work;
    try {
      await until(async()=>{const works=await api('listWorks',true);work=works.find(w=>w.team?.members?.some(m=>m.botId===members[0]));if(work)result.work=work;return work && fs.existsSync(path.join(workspace,c.b)) && work.team.executions.some(e=>e.role==='owner_summary'&&(partial?e.status==='recovered':['completed','recovered'].includes(e.status))) && !['running','queued'].includes(work.latestExecution?.status);},`${c.type}: both outputs and owner summary`);
      await until(async()=>{report.history=await history();return report.history.messages.some(m=>m.workFeedback?.workId===work.workId&&m.workFeedback?.kind==='result');},`${c.type}: original conversation result`);
      await until(async()=>{work=await api('getWork',work.workId);if(work.lifecycle==='closed')assert.equal(work.closureConclusion,'succeeded',`${c.type}: ${work.closureSummary||work.closureConclusion}`);return work.lifecycle==='closed';}, `${c.type}: final reviewed success and closure`);
      result.work=work;
      for(const [file,value] of [[c.a,c.av],[c.b,c.bv],['checked.txt',siblingValue]])assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),value,`${c.type} exact bytes ${file}`);
      const messages=requests.slice(start).flatMap(r=>r.messages||[]);
      const calls=[...new Map(messages.flatMap(m=>m.tool_calls||[]).map(c=>[c.id,c])).values()];
      result.toolCalls=calls;
      for(const file of [c.a,c.b,'checked.txt']) {const writes=calls.filter(call=>call.function?.name==='write'&&JSON.parse(call.function.arguments).path?.endsWith(file));assert.equal(writes.length,1,`${file} written once, including untouched sibling`);assert(calls.some(call=>call.function?.name==='read'&&call.function.arguments.includes(file)),`${file} readback`);}
      assert(messages.some(m=>m.role==='tool'&&JSON.stringify(m.content).includes(siblingValue.trim())), 'actual sibling readback receipt');
      assert(!JSON.stringify(messages).includes(privateMarker),'unselected private marker never enters model context');
      const db=new(require('better-sqlite3'))(path.join(agentDir,'app.db'),{readonly:true});
      try {result.recovery=db.prepare('SELECT * FROM work_team_recovery_attempts WHERE work_id=?').all(work.workId);result.bindings=db.prepare('SELECT binding_id,task_id,bot_id,status,delegated_scope_json FROM work_execution_bindings WHERE work_id=?').all(work.workId);result.reviews=db.prepare('SELECT c.* FROM work_completion_turns c JOIN work_execution_bindings b USING(binding_id) WHERE b.work_id=?').all(work.workId);} finally {db.close();}
      assert(work.team.executions.filter(e=>e.role==='owner_summary').every(e=>JSON.stringify(e.delegatedScope)===JSON.stringify(['workspace:read'])), 'owner remains read-only');
      assert(!work.team.members.some(m=>m.botId===outsider.bot.botId), 'other bot not selected');
      const member=work.team.executions.find(e=>e.botId===members[0]),sibling=work.team.executions.find(e=>e.botId===members[1]),summary=work.team.executions.find(e=>e.role==='owner_summary');
      if(partial){assert(result.recovery.some(r=>r.failure_class==='semantic_missing'&&r.state==='completed'&&r.task_id===member.taskId&&r.bot_id===members[0]),'repair reuses original member task');assert(result.recovery.some(r=>r.failure_class==='member_repaired_summary'&&r.state==='completed'&&r.task_id===summary.taskId),'owner resummary reuses original task');assert(!result.recovery.some(r=>r.task_id===sibling.taskId),'unaffected sibling never replayed');}
      else assert.equal(result.recovery.length,0,'normal tasks need no recovery');
      assert(result.bindings.filter(b=>b.task_id===summary.taskId).every(b=>b.delegated_scope_json===JSON.stringify(['workspace:read'])),'all owner attempts stay read-only');
      assert(!result.reviews.some(r=>r.decision_json && JSON.parse(r.decision_json).decision==='ask'),'no new approval question');
      result.diagnostics=await api('executionDiagnostics',{kind:'work',workId:work.workId});
      result.status='passed';console.log('TEAM_MISSING_CASE '+c.type+' passed');
    }catch(error){result.status='failed';result.error=String(error.stack||error);console.error('TEAM_MISSING_CASE '+c.type+' failed: '+error);}
    fs.writeFileSync(path.join(out,`${partial?'partial':'normal'}-${c.type}.json`),JSON.stringify(result,null,2));
    fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(report.teamMissing,null,2));
  }
  assert.equal(report.teamMissing.cases.filter(c=>c.status==='passed').length,6,'all six distinct real-model types must pass');
  report.checks.push('Six distinct real-model team tasks, exact file bytes and readback, single writes, no unselected private marker; '+(partial?'same-task missing repair and owner re-summary':'normal baseline'));
};
