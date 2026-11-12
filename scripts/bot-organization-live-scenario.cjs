/** Real-model organization supplement. This module does not start an app on import. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// These callbacks belong to the isolated driver, never to production tools.
// fault/restart return {value,evidence}; evidence must describe observed real
// state before release/restart. They cannot fabricate a successful tool result.
exports.driverContract = {
  fault: 'fault({kind,marker,targetName,output}, execute) => {value,evidence:{kind,hitAt,stateBeforeRelease,events}}',
  restart: 'restart({stage,marker,targetName,output}, execute) => {value,evidence:{stage,oldPid,newPid,home,observedAt,events}}',
  boundary: 'boundary({phase,primaryBotId,targetBotId,seed}, execute?) => actual fixture/readback evidence',
  audit: 'audit() => current real fault/process/effect audit',
};

exports.selection = (env = process.env) => {
  const caseIds=['A','B','C','D','E','F'];
  const faultKinds=['creation_storage','dispatch_storage','execution_transport','delivery_storage'];
  const selectedCases=new Set((env.BOT_ORGANIZATION_CASES||caseIds.join(',')).split(',').filter(Boolean));
  const selectedFaults=(env.BOT_ORGANIZATION_C_FAULTS||faultKinds.join(',')).split(',').filter(Boolean);
  assert(selectedCases.size&&[...selectedCases].every(id=>caseIds.includes(id)),'selected cases must be an explicit A–F subset');
  assert(selectedFaults.length&&new Set(selectedFaults).size===selectedFaults.length&&selectedFaults.every(kind=>faultKinds.includes(kind)),'selected C faults must be known unique boundaries');
  return {caseIds,faultKinds,selectedCases,selectedFaults};
};
exports.selectionStatus = (rows, selection) => {
  const {caseIds,faultKinds,selectedCases,selectedFaults}=selection;
  const selectedRows=rows.filter(row=>selectedCases.has(row.id));
  const fullSelection=selectedCases.size===caseIds.length&&selectedFaults.length===faultKinds.length;
  const complete=selectedRows.length===selectedCases.size&&new Set(selectedRows.map(row=>row.id)).size===selectedCases.size;
  return {selectedRows,fullSelection,status:complete&&selectedRows.every(row=>row.status==='passed')?(fullSelection?'passed':'selected_passed'):'failed'};
};

exports.run = async context => {
  const { send, until, evaluate: evaluateRaw, history, rpc, report, requests, out, home,
    modelKey, targetModelKey = modelKey, botId: primaryBotId, setBotId,
    organizationHooks: hooks = {} } = context;
  const selection=exports.selection();
  const {caseIds,faultKinds,selectedCases,selectedFaults}=selection;
  const evaluate = expression => { new Function(expression); return evaluateRaw(expression); };
  const seed = crypto.randomBytes(4).toString('hex');
  const fixtureRoot = path.join(home, 'organization-fixtures-' + seed);
  const workspace = name => path.join(fixtureRoot, name);
  for (const name of ['data', 'review', 'lesson', 'incident', 'calendar', 'drawing']) fs.mkdirSync(workspace(name), {recursive:true});
  const stock = path.join(fixtureRoot, 'stock.csv');
  fs.writeFileSync(stock, 'item,quantity,unit_price\nCedar,3,17\nBirch,5,23\n');
  fs.writeFileSync(path.join(workspace('review'), 'average.js'), 'export function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }\n');
  fs.writeFileSync(path.join(workspace('lesson'), 'brief.txt'), 'Audience: age 8. Theme: water cycle. Explain evaporation, condensation and precipitation. Classroom marker: CLOUD_' + seed + '\n');
  fs.writeFileSync(path.join(workspace('incident'), 'incident.txt'), 'Ticket: INC-' + seed + '\nSeverity: P2\nAffected users: 17\nCustomer: Lin\n');
  const result = report.organization = { seed,primaryBotId,home,fixtureRoot,status:'running',
    testedSource:report.sourceAtLaunch ?? null,models:{source:modelKey,target:targetModelKey},selectedCases:[...selectedCases],selectedCFaults:selectedFaults,
    cases:caseIds.map(id=>({id,status:'not_run'})),artifacts:[],limitations:[] };
  const persist = () => fs.writeFileSync(path.join(out,'organization-progress.json'),JSON.stringify(result,null,2));
  const api = (method, input) => evaluate(`window.api.botWork.${method}(${JSON.stringify(input)})`);
  const bots = () => evaluate('window.api.botWork.listBots()');
  const works = () => evaluate('window.api.botWork.listWorks(true)');
  const shot = async label => {
    const value = await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(out,'organization-'+label+'.png'),Buffer.from(value.data,'base64'));
  };
  const openArtifact = async artifact => {
    const label='打开 '+path.basename(artifact.file);
    await until(()=>evaluate(`Boolean([...document.querySelectorAll('.bot-result-files button')].find(button=>button.getAttribute('aria-label')===${JSON.stringify(label)}))`),'source official artifact-open control');
    const point=await evaluate(`(()=>{const button=[...document.querySelectorAll('.bot-result-files button')].find(item=>item.getAttribute('aria-label')===${JSON.stringify(label)});for(let node=button.parentElement;node;node=node.parentElement)if(node.tagName==='DETAILS'&&!node.open)node.querySelector(':scope>summary')?.click();button.scrollIntoView({block:'center',behavior:'instant'});const rect=button.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,visible:rect.width>0&&rect.height>0&&button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))};})()`);
    assert(point.visible,'official returned artifact-open control is visible');
    await new Promise(resolve=>setTimeout(resolve,150));
    await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:point.x,y:point.y});
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:point.x,y:point.y});
    const auditFile=path.join(out,'official-file-open.jsonl');
    let receipts=[];
    await until(()=>{
      receipts=fs.existsSync(auditFile)?fs.readFileSync(auditFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
      return receipts.some(receipt=>receipt.phase==='completed'&&receipt.channel==='workspace:readFile'&&receipt.target===artifact.savedPath);
    },'actual saved-file read receipt after source UI click');
    assert(!receipts.some(receipt=>receipt.phase==='failed'&&receipt.target===artifact.savedPath));
    let visiblePreview;
    await until(async()=>{
      visiblePreview=await evaluate(`(()=>{const preview=[...document.querySelectorAll('.bot-work-file-preview')].find(el=>el.getAttribute('aria-label')===${JSON.stringify('文件预览：'+path.basename(artifact.file))});if(!preview)return null;const body=preview.querySelector('.bot-work-file-preview-body');if(!body)return null;preview.scrollIntoView({block:'center',behavior:'instant'});const lines=[...body.querySelectorAll('.code-line-content')];const text=lines.length?lines.map(line=>line.textContent).join(String.fromCharCode(10)):body.querySelector('.view-lines')?.innerText||body.querySelector('pre')?.innerText||body.innerText;const rect=body.getBoundingClientRect();return {text,visible:rect.width>0&&rect.height>0&&rect.top<innerHeight&&rect.bottom>0,error:preview.querySelector('[role=alert]')?.innerText};})()`);
      if(!visiblePreview?.visible||!visiblePreview.text||visiblePreview.error)return false;
      try{return JSON.stringify(JSON.parse(visiblePreview.text.replace(/\u00a0/g,' ').replace(/\u200b/g,'')))===JSON.stringify(JSON.parse(fs.readFileSync(artifact.savedPath,'utf8')));}catch{return false;}
    },'visible rendered JSON equals the actual saved artifact');
    await shot('saved-preview-visible');
    await evaluate(`(()=>{const preview=[...document.querySelectorAll('.bot-work-file-preview')].find(el=>el.getAttribute('aria-label')===${JSON.stringify('文件预览：'+path.basename(artifact.file))});[...preview.querySelectorAll('button')].find(button=>button.textContent==='关闭预览').click();})()`);
    return {label,savedPath:artifact.savedPath,visiblePreview,receipts:receipts.filter(receipt=>receipt.target===artifact.savedPath)};
  };
  const allOrganizations = async () => (await history()).messages.flatMap(message=>message.organizations ?? []);
  const findIntent = async predicate => {
    let found;
    await until(async()=>{ found=(await allOrganizations()).findLast(value=>value.kind==='intent'&&predicate(value)); return Boolean(found); },'persisted organization intent');
    return found;
  };
  // Creating/configuring first and delegating in the next real tool call is
  // valid. Resolve only exact persisted source-request/target identities, never
  // infer acceptance from prose or change the host organization phase.
  const separateContacts = new Map();
  const resolveSeparateContacts = async answer => {
    const candidates=(answer.organizations??[]).filter(item=>item.kind==='intent'&&item.phase==='ready'&&item.target);
    if(!candidates.length)return;
    const relations=[];let cursor;
    do { const page=await api('collaborations',{botId:primaryBotId,limit:100,...(cursor?{cursor}:{})}); relations.push(...page.items);cursor=page.nextCursor; } while(cursor);
    for(const item of candidates){
      const matches=relations.filter(relation=>relation.sourceBotId===item.sourceBotId&&relation.sourceConversationId===item.sourceConversationId&&relation.sourceRequestId===item.sourceRequestId&&relation.targetBotId===item.target.botId&&relation.workId);
      assert(matches.length<=1,'one source organization must not have duplicate accepted Work');
      if(matches.length===1)separateContacts.set(item.intentId,matches[0]);
    }
  };
  const answerFor = async (text, allowFailure=false) => {
    let answer,user;
    await until(async()=>{
      const page=await history();user=page.messages.findLast(message=>message.role==='user'&&message.text===text);
      answer=user&&page.messages.find(message=>message.role==='assistant'&&message.requestId===user.requestId);
      return answer&&['completed','failed','unknown','cancelled'].includes(answer.status);
    },'organization foreground receipt');
    if(!allowFailure)assert.equal(answer.status,'completed',answer.error||answer.text);
    await resolveSeparateContacts(answer);
    return {answer,user};
  };
  const submit = async (text, allowFailure=false) => { await send(text); return answerFor(text,allowFailure); };
  const intentFrom = answer => {
    const value=answer.organizations?.findLast(item=>item.kind==='intent');
    assert(value,'actual assistant row has a host-persisted organization summary');return value;
  };
  const linked = value => {
    if(value.phase==='linked'){assert(value.target&&value.collaborationId);return value;}
    const relation=separateContacts.get(value.intentId);
    assert(value.phase==='ready'&&relation,JSON.stringify(value));
    return {...value,collaborationId:relation.collaborationId,acceptanceEvidence:{kind:'separate_host_collaboration',sourceRequestId:relation.sourceRequestId,workId:relation.workId}};
  };
  const journal = organization => api('collaborationHistory',{botId:primaryBotId,collaborationId:organization.collaborationId,limit:100});
  const readWork = async organization => {
    const page=await journal(organization);assert(page.collaboration.workId,'actual accepted Work link');
    return {work:await api('getWork',page.collaboration.workId),journal:page};
  };
  const waitArtifact = async (organization, directory, filename, validate, timeoutMs=360000) => {
    let observed;const deadline=Date.now()+timeoutMs;
    for(;;) {
      observed=await readWork(linked(organization));
      if(observed.work?.lifecycle==='closed')break;
      if(observed.work?.blockers?.some(blocker=>blocker.status==='open'))throw Error('actual Work blocker: '+JSON.stringify(observed.work.blockers));
      if(Date.now()>deadline)throw Error('actual target Work did not complete: '+filename);
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(observed.work.closureConclusion,'succeeded',JSON.stringify(observed.work));
    assert.equal(observed.work.ownerBotId,organization.target.botId);
    assert(!observed.work.team,'organization uses personal Work');
    const file=path.join(directory,filename);assert(fs.existsSync(file),'actual target output '+file);
    const contents=fs.readFileSync(file,'utf8');validate(contents);
    await until(async()=>{
      observed=await readWork(organization);
      return observed.journal.messages.some(message=>message.kind==='result');
    },'actual organization result returned');
    const delivered=observed.journal.messages.flatMap(message=>message.workFeedback?.report?.files??[]).findLast(item=>item.name===filename);
    assert(delivered?.openPath||delivered?.artifact?.snapshotPath,'actual result has an openable saved artifact');
    const savedPath=delivered.openPath||delivered.artifact.snapshotPath;
    assert(fs.existsSync(savedPath),'returned saved artifact exists');
    validate(fs.readFileSync(savedPath,'utf8'));
    const artifact={workId:observed.work.workId,targetBotId:organization.target.botId,intentId:organization.intentId,
      collaborationId:organization.collaborationId,file,savedPath,sha256:crypto.createHash('sha256').update(contents).digest('hex')};
    result.artifacts.push(artifact);return {...observed,artifact};
  };
  const createPrompt = ({name,responsibility,directory,task,isolatedIdentity=false,fileToolsOnly=false}) =>
    `这是主 Bot 的组织验收 ${seed}。先真实查询已有 Bot 的职责、能力和状态，优先复用合适者。现在需要专门的“${name}”，职责是${responsibility}。`+
    (isolatedIdentity ? `本次是故障隔离试验，用户明确要求新建一个独立身份“${name}”；现有 Bot 不满足本次独立身份要求，不复用或重命名它们，保留所有已有配置。` : '')+
    `如果当前没有匹配者，用宿主 bot_organize 真实创建并配置，目标模型选目录中可用的 ${targetModelKey}，目标工作区 ${directory}。`+
    `然后在同一条个人协作中直接委派一次性 Work，不创建团队，目标 Bot 是唯一 owner。${task}`+
    (fileToolsOnly ? `本次仅允许文件工具完成生成、回读、本地校验和 register_artifact 登记；不要 browser_exec、ui_exec、computer_exec、浏览器打开、截图、滚动或任何可选 GUI QA，不安装软件。成品的源会话官方预览另行验证，不属于此 Work。` : '')+
    `主会话立即返回真实受理状态和可继续的 intentId/协作入口，不能把创建成功说成已完成。所有成果都必须实际写入、回读并登记。`;
  const requireHook = name => { assert.equal(typeof hooks[name],'function','missing real isolated organization driver hook: '+name);return hooks[name]; };
  const fault = async (spec, execute) => {
    const observed=await requireHook('fault')(spec,execute);
    assert(observed?.evidence&&observed.evidence.kind===spec.kind&&Number.isFinite(observed.evidence.hitAt),'real fault hit evidence');
    assert(observed.evidence.stateBeforeRelease,'production state captured while fault was active');
    return observed;
  };
  const restart = async (spec,execute) => {
    const observed=await requireHook('restart')(spec,execute);
    assert(observed?.evidence&&observed.evidence.stage===spec.stage,'real restart stage evidence');
    assert(observed.evidence.oldPid&&observed.evidence.newPid&&observed.evidence.oldPid!==observed.evidence.newPid,'real isolated main process changed');
    assert.equal(fs.realpathSync(observed.evidence.home),fs.realpathSync(home),'restart uses exact same synthetic profile');
    return observed;
  };
  const resume = async (organization, extra='') => {
    const reply=await submit(`继续原组织 intentId=${organization.intentId}。使用 bot_organize resume 核对原意图，不创建新 Bot，不重新配置已成功的设置，不新建协作或 Work。若已关联 Work 且实际执行失败，必须继续用该 collaborationId 调用 bot_collaborate query，携带实际 versionGuard resume 原 Work；不要把组织已关联当作原执行已恢复。${extra}`);
    return reply.answer.organizations?.findLast(item=>item.kind==='intent') ?? findIntent(item=>item.intentId===organization.intentId);
  };
  const runCase = async (id,type,execute) => {
    const row=result.cases.find(item=>item.id===id);assert(row);
    if(!selectedCases.has(id)){row.reason='not selected in this explicit supplemental run';persist();return;}
    Object.assign(row,{type,status:'running',startedAt:Date.now(),providerOffset:requests.length});persist();
    let fatal;
    try { await execute(row);row.status='passed'; }
    catch(error) { row.status='failed';row.error=String(error.stack||error);console.error(id,row.error);
      if(/Owned organization driver/.test(row.error)||(requests.length===row.providerOffset&&/unable to open database|SQLITE_CANTOPEN|EBADF|EACCES/.test(row.error)))fatal=error; }
    row.endedAt=Date.now();row.modelCalls=requests.length-row.providerOffset;persist();
    console.log(JSON.stringify({organizationCase:id,status:row.status,modelCalls:row.modelCalls,error:row.error}));
    if(fatal){result.status='failed';persist();throw fatal;}
  };
  let dataOrganization;

  await runCase('A','CSV reconciliation: create, configure, delegate and deliver',async row=>{
    const beforeBots=await bots(),beforeWorks=await works();
    const prompt=createPrompt({name:'核算与语言助理-'+seed,responsibility:'CSV 核算、翻译与来源核对',directory:workspace('data'),
      task:`真实读取 ${stock}，按 quantity*unit_price 求和，写 invoice-summary.json，含 total、两行明细和 marker=${seed}。`});
    const reply=await submit(prompt);row.requestId=reply.user.requestId;
    dataOrganization=linked(intentFrom(reply.answer));row.organization=dataOrganization;
    const accepted=await waitArtifact(dataOrganization,workspace('data'),'invoice-summary.json',contents=>{
      const value=JSON.parse(contents);assert.equal(value.total,166);assert.equal(value.marker,seed);
    });row.observed=accepted;
    row.officialOpen=await openArtifact(accepted.artifact);
    assert.equal((await bots()).length,beforeBots.length+1);
    assert.equal((await works()).length,beforeWorks.length+1);
    const settings=(await api('getSettings',dataOrganization.target.botId)).settings;
    assert.equal(settings.modelId,targetModelKey);assert.equal(fs.realpathSync(settings.effectiveWorkspacePath),fs.realpathSync(workspace('data')));
    assert(dataOrganization.times.botCreatedAt!==null&&dataOrganization.times.configuredAt!==null&&dataOrganization.times.linkedAt!==null);
    const source=await api('queryWorks',{scope:{kind:'personal',botId:primaryBotId},view:'all'});
    assert(!source.works.some(item=>item.workId===accepted.work.workId),'source does not own delegated Work');
    assert(requests.some(request=>request.model===targetModelKey.replace(/^fixture\//,'')&&JSON.stringify(request.messages).includes(accepted.work.workId)),
      'actual native execution uses selected target model');
    await shot('created-delivered');
  });

  await runCase('B','Translation: reuse, pure consultation and lost-receipt retry',async row=>{
    assert(dataOrganization,'CSV scenario created a suitable existing language Bot');
    const beforeBots=await bots(),beforeWorks=await works();
    const beforeSettings=(await api('getSettings',dataOrganization.target.botId)).settings;
    const question=`请通过原协作 ${dataOrganization.collaborationId} 向“${dataOrganization.target.displayName}”只读询问：把 Please send the invoice tomorrow morning 翻成自然中文。保留真实对方身份，不创建 Work 或新 Bot。`;
    const asked=await submit(question);row.consultation=asked;
    assert.equal((await works()).length,beforeWorks.length,'pure consultation creates no Work');
    const originalJournal=await journal(dataOrganization);
    assert(originalJournal.messages.some(message=>message.kind==='reply'&&/发票/.test(message.text)&&/明天|明早/.test(message.text)));
    const reuseCommand={action:'arrange',target:{kind:'existing',botId:dataOrganization.target.botId},contact:{kind:'delegate',plan:{
      title:'既有助理翻译复用-'+seed,goalDescription:`把 Please send the invoice tomorrow morning 和 Shipment confirmed 写成 reused-translation.md 的中英对照，包含 ${seed}。实际保存、回读并登记。`,requestedOutcome:'one_time',mode:'once'}}};
    const reusePrompt=`这是同一个逻辑请求 REUSE_${seed}，用户明确指定现有“${dataOrganization.target.displayName}” ${dataOrganization.target.botId}。先真实 discover 核对现有职责与配置，不能新建 Bot 或改配。若此逻辑请求已有组织意图，只 query/resume 原 intent；否则严格调用如下 bot_organize JSON，保留实际目标设置：${JSON.stringify(reuseCommand)}`;
    const reusedReply=await submit(reusePrompt),reused=linked(intentFrom(reusedReply.answer));
    assert.equal(reused.target.botId,dataOrganization.target.botId,'management reuses the actual suitable existing target');
    assert.equal(reused.times.botCreatedAt,null,'reuse records no fabricated creation');
    assert.equal(reused.times.configuredAt,null,'reuse does not silently change unrelated configuration');
    row.reuse={organization:reused,observed:await waitArtifact(reused,workspace('data'),'reused-translation.md',contents=>{
      assert(contents.includes(seed)&&/发票/.test(contents)&&/Shipment confirmed/.test(contents));
    })};
    assert.equal((await bots()).length,beforeBots.length);assert.equal((await works()).length,beforeWorks.length+1);
    const repeated=await submit(reusePrompt);row.duplicateRequest={userRequestId:repeated.user.requestId,answer:repeated.answer};
    assert.equal((await bots()).length,beforeBots.length,'duplicate logical request does not create another Bot');
    assert.equal((await works()).length,beforeWorks.length+1,'duplicate logical request does not create another Work');
    assert.deepEqual((await api('getSettings',dataOrganization.target.botId)).settings,beforeSettings,'real existing-target management preserves all settings');
    const marker='LOST_RECEIPT_'+seed;
    const translated=await fault({kind:'creation_response_loss',marker,targetName:'翻译恢复助理-'+seed,output:'translated-brief.md'},()=>submit(
      createPrompt({name:'翻译恢复助理-'+seed,responsibility:'英文商务资料翻译及双语说明',directory:workspace('data'),
        isolatedIdentity:true,
        task:`${marker} 把上述英文句子及“Shipment confirmed”写成 translated-brief.md 的中英对照，包含 ${seed}。`}),true));
    row.fault=translated.evidence;
    assert(translated.evidence.intentId,'actual fault evidence identifies the original creation intent');
    const pending=await findIntent(item=>item.intentId===translated.evidence.intentId);
    const retried=linked(await resume(pending));row.organization=retried;
    row.observed=await waitArtifact(retried,workspace('data'),'translated-brief.md',contents=>{
      assert(contents.includes(seed)&&/发票/.test(contents)&&/Shipment confirmed/.test(contents));
    });
    assert.equal((await bots()).length,beforeBots.length+1,'lost response creates exactly one new target');
    assert.equal((await works()).length,beforeWorks.length+2);
    assert.deepEqual((await api('getSettings',dataOrganization.target.botId)).settings,beforeSettings,'existing target unrelated settings unchanged');
    await shot('reuse-and-retry');
  });

  await runCase('C','JavaScript review: real failure and continuation at four boundaries',async row=>{
    row.failures=[];
    const sourceFile=path.join(workspace('review'),'average.js'),original=fs.readFileSync(sourceFile,'utf8');
    for(const kind of selectedFaults) {
      const marker=kind+'_'+seed,name='代码审查员-'+marker,output='review-'+kind+'.md';
      const observed=await fault({kind,marker,targetName:name,output},()=>submit(createPrompt({name,
        isolatedIdentity:true,
        responsibility:'读取 JavaScript 并审查边界条件，保留原文件',directory:workspace('review'),
        task:`${marker} 读取 average.js，解释空数组问题，写 ${output}，给出原因、修复建议、空数组和非空数组两个测试例子。不修改 average.js。`}),true));
      assert(observed.evidence.intentId,'fault continuation must resume the originally observed intent');
      const pending=await findIntent(item=>item.intentId===observed.evidence.intentId);
      const continued=linked(await resume(pending,'按真实已完成步骤继续，不重演完成的副作用。'));
      const accepted=await waitArtifact(continued,workspace('review'),output,contents=>assert(/NaN|0\s*\/\s*0/.test(contents)));
      assert.equal(fs.readFileSync(sourceFile,'utf8'),original);
      const returns=accepted.journal.messages.filter(message=>message.kind==='result'&&message.workFeedback?.report?.files?.some(file=>file.name===output));
      // An honest unknown fallback followed by a completed review is a status
      // correction, not duplicate delivery. Preserve both immutable messages.
      const completed=returns.filter(message=>message.workFeedback?.report?.completion?.outcome==='completed');
      assert.equal(completed.length,1,'exactly one successful final return');
      assert.equal(new Set(returns.map(message=>message.operationId)).size,returns.length,'no duplicated delivery identity');
      assert(returns.every(message=>message===completed[0] || message.createdAt<=completed[0].createdAt && ['unknown','partial'].includes(message.workFeedback?.report?.completion?.outcome)), 'earlier non-success must remain distinct and precede success');
      row.failures.push({kind,evidence:observed.evidence,organization:continued,observed:accepted});persist();
    }
    await shot('failure-continuation');
  });

  await runCase('D','Offline HTML lesson: actual main-process restart at three stages',async row=>{
    row.restarts=[];
    for(const stage of ['created_before_contact','execution_in_progress','artifact_pending_return']) {
      const marker=stage+'_'+seed,name='课堂设计员-'+marker,output='lesson-'+stage+'.html';
      const observed=await restart({stage,marker,targetName:name,output,directory:workspace('lesson')},()=>submit(createPrompt({name,
        isolatedIdentity:true,
        fileToolsOnly:true,
        responsibility:'只用文件工具制作儿童离线教材、保存阶段成果并本地回读登记；不使用浏览器、ui_exec、截图或任何GUI QA',directory:workspace('lesson'),
        task:`${marker} 读取 brief.txt，先写并登记 outline-${stage}.md，再写 ${output}，至少六节，解释蒸发、凝结、降水，包含课堂提问和 CLOUD_${seed}。HTML 自包含，不依赖网络。`}),true));
      assert(observed.evidence.intentId,'restart evidence preserves original organization identity');
      const pending=await findIntent(item=>item.intentId===observed.evidence.intentId);
      const continued=linked(await resume(pending));
      const accepted=await waitArtifact(continued,workspace('lesson'),output,contents=>{
        const document=require('linkedom').parseHTML(contents).document;
        assert(document.querySelector('html')&&document.querySelector('body'));
        assert(document.body.textContent.includes('CLOUD_'+seed));
        assert(/蒸发/.test(document.body.textContent)&&/凝结/.test(document.body.textContent)&&/降水/.test(document.body.textContent));
        assert(![...document.querySelectorAll('[src],[href]')].some(element=>/^https?:|^\/\//.test(element.getAttribute('src')||element.getAttribute('href')||'')));
      },600000);
      if(stage==='execution_in_progress'){
        assert.equal(typeof hooks.verifyRestart,'function','completed-step restart needs actual write audit');
        observed.evidence.completedStepAudit=await hooks.verifyRestart({stage,directory:workspace('lesson')},observed.evidence);
        assert(observed.evidence.completedStepAudit.noRepeatedOutlineWrite,'completed outline step was not executed again');
      }
      row.restarts.push({stage,evidence:observed.evidence,organization:continued,observed:accepted});persist();
    }
    await shot('restart-recovery');
  });

  await runCase('E','Concurrent incident extraction and calendar authoring with directed amendment/cancel',async row=>{
    const concurrent=requireHook('boundary');
    const marker='CONCURRENT_'+seed;
    const prompt=`${marker} 主 Bot 先查现有 Bot，分别安排两个不同的个人目标同时执行，不创建团队。`+
      `工单整理员-${seed} 在 ${workspace('incident')} 读取 incident.txt，写 incident.json，准确提取 ticket、severity、affectedUsers。`+
      `日程整理员-${seed} 在 ${workspace('calendar')} 写 meeting.ics，会议在 2030-05-06 01:00 至 01:30 UTC，SUMMARY 为 Review ${seed}，DTSTART 必须是 20300506T010000Z，DTEND 是 20300506T013000Z。`+
      `需要创建时用真实管理工具和可用 ${targetModelKey}。各自先登记阶段结果，继续执行；前台立即交还。`;
    const observed=await concurrent({phase:'concurrent_amend_cancel',primaryBotId,seed,marker,incidentDirectory:workspace('incident'),calendarDirectory:workspace('calendar')},()=>submit(prompt));
    assert(observed?.evidence?.overlap&&observed.evidence.frontendReply,'actual two-Work overlap and foreground response evidence');
    assert(observed.evidence.sameIntentConcurrentAdmission,'actual same-intent concurrent admission evidence');
    assert(observed.evidence.targetedAmendment&&observed.evidence.cancellation,'real guarded control receipts');
    assert(observed.evidence.completedIncidentIntentId&&observed.evidence.completedCalendarIntentId,'actual IDs distinguish completed tasks from the independent cancellation run');
    const incident=linked(await findIntent(item=>item.intentId===observed.evidence.completedIncidentIntentId));
    const calendar=linked(await findIntent(item=>item.intentId===observed.evidence.completedCalendarIntentId));
    assert.notEqual(incident.target.botId,calendar.target.botId);assert.notEqual(incident.collaborationId,calendar.collaborationId);
    row.incident=await waitArtifact(incident,workspace('incident'),'incident.json',contents=>{
      const value=JSON.parse(contents);assert.equal(value.ticket,'INC-'+seed);assert.equal(value.severity,'P2');assert.equal(value.affectedUsers,17);
    });
    row.calendar=await waitArtifact(calendar,workspace('calendar'),'meeting.ics',contents=>{
      assert(contents.includes('DTSTART:20300506T010000Z')&&contents.includes('DTEND:20300506T013000Z')&&contents.includes('Review '+seed));
    });
    const cancelledId=observed.evidence.cancellation.workId;
    const unaffectedId=observed.evidence.cancellation.otherWorkId;
    assert(cancelledId&&unaffectedId&&cancelledId!==unaffectedId,'independent cancellation run has two actual Work IDs');
    assert(![row.incident.work.workId,row.calendar.work.workId].includes(cancelledId),'a cancelled task is not also asserted to have completed successfully');
    let cancelled,unaffected;
    await until(async()=>{
      cancelled=await api('getWork',cancelledId);unaffected=await api('getWork',unaffectedId);
      return cancelled?.lifecycle==='closed'&&unaffected?.lifecycle==='closed';
    },'real targeted cancellation and unaffected sibling settlement');
    assert.equal(cancelled.closureConclusion,'cancelled');
    assert.equal(unaffected.closureConclusion,'succeeded');
    row.cancelledWork=cancelled;row.unaffectedWork=unaffected;
    row.evidence=observed.evidence;await shot('parallel-controls');
  });

  await runCase('F','Static SVG: stable role, private ownership and exact archived/deleted origins',async row=>{
    const boundary=requireHook('boundary');
    const setup=await boundary({phase:'private_fixture',primaryBotId,seed});
    assert(setup?.evidence?.privateSkillFiles&&setup.evidence.privateMemoryScopes,'actual scoped synthetic private fixture evidence');
    const name='几何绘图员-'+seed;
    const reply=await submit(createPrompt({name,responsibility:'用自包含 SVG 绘制给定几何说明',directory:workspace('drawing'),
      task:`写 geometry.svg，画 120x80 的矩形和半径 20 的圆，viewBox 至少覆盖图形，文字含 SHARED_${seed}。只传递本次明确给定的内容，不读取其他 Bot 私有记忆或 Skill。`}));
    const organization=linked(intentFrom(reply.answer));row.organization=organization;
    row.observed=await waitArtifact(organization,workspace('drawing'),'geometry.svg',contents=>{
      const document=require('linkedom').parseHTML(contents).document;
      assert(document.querySelector('svg')&&document.querySelector('rect')&&document.querySelector('circle'));
      assert(contents.includes('SHARED_'+seed));
    });
    const verified=await boundary({phase:'verify_role_private_origin',primaryBotId,targetBotId:organization.target.botId,
      intentId:organization.intentId,collaborationId:organization.collaborationId,seed});
    assert(verified?.evidence?.renamedPrimaryId===primaryBotId&&verified.evidence.newConversationPrimaryId===primaryBotId,'rename and fresh conversation preserve stable primary');
    assert(verified.evidence.ordinaryManagementRejected&&verified.evidence.ordinaryCollaborationWorked,'ordinary does not create recursively and retains ordinary ability');
    assert(verified.evidence.privateWireIsolation&&verified.evidence.privateSkillRootIsolation,'actual provider and frozen package ownership evidence');
    assert(verified.evidence.teamCountsIndependent&&verified.evidence.archivedExactOrigin&&verified.evidence.deletedNoFallback,'actual personal/team and original destination evidence');
    row.setup=setup.evidence;row.evidence=verified.evidence;await shot('identity-private-origin');
  });

  if(typeof hooks.audit==='function')result.driverAudit=await hooks.audit();
  result.limitations.push('This supplement is separate from earlier six-type collaboration acceptance.');
  result.limitations.push('Real Gateway file delivery, Connector login, native OS input and packaged app acceptance are not established by this local dev/CDP run.');
  const {selectedRows,fullSelection,status}=exports.selectionStatus(result.cases,selection);
  result.status=status;
  if(!fullSelection)result.limitations.push('Explicit selected supplement only; unselected cases are not_run. This report alone does not pass all six scenarios.');
  persist();assert.equal(selectedRows.length,selectedCases.size);assert(selectedRows.every(row=>row.status==='passed'),'every explicitly selected organization scenario must pass');
  report.checks.push(fullSelection?'six distinct organization model scenarios, actual host management and target-owned Work/artifacts, controlled real faults/restarts, original-source/private boundaries':`selected real organization supplement cases ${[...selectedCases].join(',')}; C boundaries ${selectedFaults.join(',')}; unselected cases not run`);
};
