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
  {name:'网页资料核查',file:'web-target.txt',content:'https://example.com/\n',goal:'先读取web-target.txt中实际发布的URL，再联网读取该URL，报告网页标题和用途，不只是复述URL；资料没有发布前不能猜URL',expected:'Example Domain'},
 ];
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 report.scenarios=[];
 const details=id=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 for(let index=0;index<cases.length;index++){
  const c=cases[index],target=path.join(workspace,c.file),brief=path.join(workspace,`brief-${index}.txt`);
  if(c.extra)fs.writeFileSync(path.join(workspace,c.extra),c.extraContent);
  fs.writeFileSync(brief,`待核查资料路径：${target}${c.extra?' 和 '+path.join(workspace,c.extra):''}。本线索文件没有具体结果，必须读取目标资料才能回答。\n`);
  const prior=(await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId);
  const title=`补查-${c.name}-${seed}`;
  await send(`建立持续委托，标题“${title}”，每分钟整点（UTC，cron * * * * *）检查，创建工具只传cronExpression和timezone，不填写nextWakeAt，下一次时间由宿主计算。目标：${c.goal}。资料索引是 ${brief}，实际资料可能尚未发布。若本次找不到或读不全，应由前台自主补查完成原目标，不要问我，不要等下一周期；每次执行如实返回目前取得的事实，不冒充已取得目标资料。后续保持持续委托直到我暂停，当前不要提前检查。全程只读，不写入不发送不发布。`);
  await foregroundDone();
  const list=await evaluate('window.api.botWork.listWorks(true)');const item=list.find(w=>!prior.includes(w.workId));assert(item,'actual Work created for '+c.name);
  const id=item.workId;assert.equal(item.mode,'watch');
  let w,entry;
  // Real source publication after the first observation, not a mocked tool/model response.
  await until(async()=>{w=await details(id);return executions(id).some(e=>['completed','failed'].includes(e.status));},'initial unpublished source observation '+c.name);
  fs.writeFileSync(target,c.content);
  if(c.name==='网页资料核查'){
   const existingPath=process.env.BOT_WEB_EXISTING_PROXY_CONFIG;
   if(existingPath){const {parse,stringify}=require('yaml'),e=parse(fs.readFileSync(existingPath,'utf8'));
    const compatible={tun:{enable:e.tun?.enable},dns:{enable:e.dns?.enable,'enhanced-mode':e.dns?.['enhanced-mode'],'fake-ip-range':e.dns?.['fake-ip-range'],nameserver:e.dns?.nameserver},'mixed-port':e['mixed-port'],'allow-lan':e['allow-lan'],authentication:e.authentication?.length?['unsupported-authentication']:[],'bind-address':e['bind-address']};
    const dest=path.join(home,'.local/share/com.follow.clash/config.yaml');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,stringify(compatible));report.existingProxyConfigurationCopied=true;}
  }
  await until(async()=>{
   w=await details(id);report.latestWork=w;
   const h=await history();report.history=h;
   entry=h.messages.find(m=>m.workFeedback?.workId===id&&m.workFeedback?.kind==='result'&&m.text.includes(c.expected)
    && executions(id).some(e=>e.bindingId===m.workFeedback.executionId&&e.status==='completed'));
   return !!entry;
  },'real autonomous supplemental '+c.name);
  assert.equal(w.lifecycle,'active','one successful supplement is not end of standing Work');
  assert(!entry.text.includes('前台整理失败'),'actual model review, not fallback');
  const supplemental=executions(id).find(e=>e.bindingId===entry.workFeedback.executionId);
  assert.deepEqual(supplemental.delegatedScope,['workspace:read']);
  const autonomousSupplement = !supplemental.inboxEventId;
  assert(w.phase4.subscriptions.some(s=>s.cronExpression==='* * * * *'&&!s.stoppedAt),'original schedule remains');
  await send(`暂停持续委托 ${id}，保留已有结果，不再检查。`);await foregroundDone();
  w=await details(id);assert.equal(w.lifecycle,'paused');
  assert.equal(fs.readFileSync(target,'utf8'),c.content,'no business writes');
  report.scenarios.push({name:c.name,workId:id,executionId:supplemental.bindingId,expected:c.expected,actual:entry.text,autonomousSupplement,executions:executions(id),paused:true});
  fs.writeFileSync(path.join(out,'supplement-progress.json'),JSON.stringify(report.scenarios,null,2));
 }
 database.close();
 report.history=await history();
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'watch-supplement-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 report.checks.push('six real model task types: release, CSV arithmetic, log diagnosis, JSON config, document comparison, public web lookup; initial unpublished source observation -> autonomous follow-up or retained cron (recorded separately) -> real readonly tools -> owner result; all standing schedules retained then explicitly paused');
};
