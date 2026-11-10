const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,out,home,modelKey,botId,agentDir})=>{
 const workspace=path.join(home,'supplement-source');fs.mkdirSync(workspace,{recursive:true});
 const seed=crypto.randomBytes(4).toString('hex');
 const database=new (require('better-sqlite3'))(path.join(agentDir,'app.db'),{readonly:true});
 const executions=id=>database.prepare('SELECT binding_id bindingId,inbox_event_id inboxEventId,status,delegated_scope_json FROM work_execution_bindings WHERE work_id=? ORDER BY admitted_at,rowid').all(id).map(e=>({...e,delegatedScope:JSON.parse(e.delegated_scope_json)}));
 const cases=[
  {name:'发布状态',file:'release.txt',content:`RELEASE_${seed}=READY\n`,goal:'确认发布状态，报告原文',expected:`RELEASE_${seed}=READY`},
  {name:'库存汇总',file:'stock.csv',content:'sku,quantity\nA,17\nB,29\n',goal:'汇总CSV库存数量并报告合计',expected:'46'},
  {name:'日志排障',file:'app.log',content:'INFO startup\nERROR E742 database offline\nINFO retry queued\n',goal:'找出日志中错误代码和原因',expected:'E742'},
  {name:'配置核查',file:'config.json',content:JSON.stringify({environment:'staging',service:{port:48317,enabled:true}}),goal:'读取JSON确认service.port实际值',expected:'48317'},
  {name:'文档对比',file:'version-b.txt',content:'版本B：保修36个月\n',extra:'version-a.txt',extraContent:'版本A：保修12个月\n',goal:'对比A、B文档保修期限，报告从12个月到36个月的变化',expected:'36'},
  {name:'待办清单提取',file:'checklist.md',content:'# 今日待办\n- [x] 已发货\n- [ ] 核对运单 ZK193\n',goal:'读取Markdown清单，指出唯一未完成事项和运单号',expected:'ZK193'},
 ];
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 report.scenarios=[]; report.sourcesInitiallyReady=true;
 const details=id=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 const nativeProof=(bindingId,c,target)=>{
  const row=database.prepare('SELECT context_json FROM work_watch_reviews WHERE binding_id=?').get(bindingId);
  const observations=row ? JSON.parse(row.context_json).verifiedObservations ?? [] : [];
  const source=observations.find(o=>o.source===target&&o.text.includes(c.content.trim()));
  const extra=!c.extra||observations.some(o=>o.source===path.join(workspace,c.extra)&&o.text.includes(c.extraContent.trim()));
  const web=c.name!=='网页资料核查'||observations.some(o=>o.source?.includes('example.com')&&o.text.includes('Example Domain'));
  return source&&extra&&web ? observations : undefined;
 };
 // Initialize the isolated profile's existing resolver/proxy projection before any real fetch.
   const existingPath=process.env.BOT_WEB_EXISTING_PROXY_CONFIG;
   if(existingPath){const {parse,stringify}=require('yaml'),e=parse(fs.readFileSync(existingPath,'utf8'));
    const compatible={tun:{enable:e.tun?.enable},dns:{enable:e.dns?.enable,'enhanced-mode':e.dns?.['enhanced-mode'],'fake-ip-range':e.dns?.['fake-ip-range'],nameserver:e.dns?.nameserver},'mixed-port':e['mixed-port'],'allow-lan':e['allow-lan'],authentication:e.authentication?.length?['unsupported-authentication']:[],'bind-address':e['bind-address']};
    const dest=path.join(home,'.local/share/com.follow.clash/config.yaml');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,stringify(compatible));report.existingProxyConfigurationCopied=true;}
 for(let index=0;index<cases.length;index++){
  const c=cases[index],target=path.join(workspace,c.file),brief=path.join(workspace,`brief-${index}.txt`);
  fs.writeFileSync(target,c.content);
  if(c.extra)fs.writeFileSync(path.join(workspace,c.extra),c.extraContent);
  fs.writeFileSync(brief,`待核查资料路径：${target}${c.extra?' 和 '+path.join(workspace,c.extra):''}。本线索文件没有具体结果，必须读取目标资料才能回答。\n`);
  const prior=(await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId);
  const title=`补查-${c.name}-${seed}`;
  await send(`建立持续委托，标题“${title}”，每小时整点（UTC，cron 0 * * * *）检查，不要立即执行。目标：${c.goal}。资料索引是 ${brief}，实际资料已发布。只读、不写入不发送不发布，保持持续委托直到我暂停。`);
  await foregroundDone();
  const list=await evaluate('window.api.botWork.listWorks(true)');const item=list.find(w=>!prior.includes(w.workId));assert(item,'actual Work created for '+c.name);
  const id=item.workId;assert.equal(item.mode,'watch');
  let w,entry;
  await send(`暂停 ${id}，保留计划，不要检查。`); await foregroundDone();
  assert.equal((await details(id)).lifecycle,'paused');
  const current=database.prepare('SELECT state_version,intent_revision,owner_epoch FROM works WHERE work_id=?').get(id);
  const deadlineAt=Date.now()+2000;
  const set=await evaluate(`window.api.botWork.phase4Control(${JSON.stringify({kind:'set-deadline',operationId:'deadline-'+seed+'-'+index,workId:id,deadlineAt,versionGuard:{expectedStateVersion:current.state_version,expectedIntentRevision:current.intent_revision,expectedOwnerEpoch:current.owner_epoch}})})`);
  assert(set.ok,'deadline set via real product IPC');
  await until(async()=>database.prepare("SELECT state FROM work_deadline_instances WHERE work_id=? AND deadline_at=?").get(id,deadlineAt)?.state==='followed-up','paused deadline recorded');
  assert.equal(executions(id).length,0,'paused deadline does not execute');
  await send(`恢复 ${id}，继续原委托并补查暂停期间错过的期限，保持每小时计划。`);await foregroundDone();
  await until(async()=>{
   w=await details(id);report.latestWork=w;
   const h=await history();report.history=h;
   entry=h.messages.find(m=>m.workFeedback?.workId===id&&m.workFeedback?.kind==='result'&&m.text.includes(c.expected)
    && executions(id).some(e=>e.bindingId===m.workFeedback.executionId&&e.status==='completed')
    && nativeProof(m.workFeedback.executionId,c,target));
   return !!entry;
  },'real autonomous supplemental '+c.name);
  assert.equal(w.lifecycle,'active','one successful supplement is not end of standing Work');
  assert(!entry.text.includes('前台整理失败'),'actual model review, not fallback');
  const supplemental=executions(id).find(e=>e.bindingId===entry.workFeedback.executionId);
  assert.deepEqual(supplemental.delegatedScope,['workspace:read']);
  const autonomousSupplement = !supplemental.inboxEventId;
  const event=database.prepare('SELECT event_type FROM work_events_inbox WHERE event_id=?').get(supplemental.inboxEventId);
  assert.equal(event?.event_type,'deadline_expired','result comes from missed deadline, not regular cron');
  assert.equal(database.prepare("SELECT count(*) n FROM work_events_inbox WHERE work_id=? AND event_type='deadline_expired'").get(id).n,1);
  assert(w.phase4.subscriptions.some(s=>s.cronExpression==='0 * * * *'&&!s.stoppedAt),'original schedule remains');
  await send(`暂停持续委托 ${id}，保留已有结果，不再检查。`);await foregroundDone();
  w=await details(id);assert.equal(w.lifecycle,'paused');
  assert.equal(fs.readFileSync(target,'utf8'),c.content,'no business writes');
  report.scenarios.push({name:c.name,workId:id,executionId:supplemental.bindingId,expected:c.expected,actual:entry.text,autonomousSupplement,nativeEvidence:nativeProof(supplemental.bindingId,c,target),executions:executions(id),paused:true});
  fs.writeFileSync(path.join(out,'deadline-progress.json'),JSON.stringify(report.scenarios,null,2));
 }
 database.close();
 report.history=await history();
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'deadline-followup-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 report.checks.push('six real task types: release, CSV, log, JSON, document comparison, Markdown checklist; paused deadline recorded -> real natural-language resume -> exactly one deadline execution -> real source read -> correct original Bot result; hourly schedule retained');
};
