/** Real model acceptance through the visible Electron composer. Setup/readback uses IPC. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

exports.run = async ({send, until, evaluate: evaluateRaw, history, rpc, report, requests, out, home, modelKey, targetModelKey, botId, setBotId}) => {
  const evaluate = expression => {
    new Function(expression);
    return evaluateRaw(expression);
  };
  const sourceBotId = botId, seed = crypto.randomBytes(4).toString('hex');
  const sourceWorkspace = path.join(home, 'collaboration-source');
  const workspaceA = path.join(home, 'collaboration-target-a');
  const workspaceB = path.join(home, 'collaboration-target-b');
  const documentDirectory = path.join(home, 'user-documents');
  for (const directory of [sourceWorkspace, workspaceA, workspaceB, documentDirectory]) fs.mkdirSync(directory, {recursive:true});
  const fixture = path.join(documentDirectory, 'stock-'+seed+'.csv');
  fs.writeFileSync(fixture, 'item,quantity,unit_price\nCedar,3,17\nBirch,5,23\n');
  fs.writeFileSync(path.join(workspaceA, 'average.js'), 'export function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }\n');
  fs.writeFileSync(path.join(workspaceA, 'lesson-brief.txt'), 'Audience: children age 8. Theme: water cycle. Required classroom marker: CLOUD_'+seed+'. Explain evaporation, condensation and precipitation.\n');
  fs.writeFileSync(path.join(workspaceB, 'incident.txt'), 'Ticket: INC-'+seed+'\nCustomer: Lin\nSeverity: P2\nAffected users: 17\nSummary: delayed invoice export\n');
  const createdA = await evaluate(`window.api.botWork.createBot(${JSON.stringify({requestId:crypto.randomUUID(),displayName:'杉树核算员',responsibilitySummary:'数学核算、文件数据分析、代码审查与离线教材制作。你的每次最终回答末尾独立写配置标识 CONFIG_CEDAR_'+seed+'。写 JSON 时可将标识放在 configMarker 字段，写 HTML 时可用注释。必须实际读取资料，真实写文件后回读核对。'})})`);
  const createdB = await evaluate(`window.api.botWork.createBot(${JSON.stringify({requestId:crypto.randomUUID(),displayName:'白桦资料员',responsibilitySummary:'语言翻译与资料结构化整理。你的每次最终回答末尾独立写配置标识 CONFIG_BIRCH_'+seed+'。写 JSON 时可将标识放在 configMarker 字段。必须读取资料并核对实际输出。'})})`);
  assert(createdA.ok && createdB.ok, 'two actual target Bots created');
  const targetA = createdA.bot.botId, targetB = createdB.bot.botId;
  const configure = async (id, workspacePath, modelId) => {
    const settings = (await evaluate(`window.api.botWork.getSettings(${JSON.stringify(id)})`)).settings;
    const saved = await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId:id,expectedRevision:settings.revision,workspacePath,modelId,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`);
    assert(saved.ok, JSON.stringify(saved));
    return saved.view.settings;
  };
  const configurations = { source:await configure(sourceBotId, sourceWorkspace, modelKey),
    targetA:await configure(targetA, workspaceA, targetModelKey), targetB:await configure(targetB, workspaceB, modelKey) };
  report.collaboration = { seed,sourceBotId,targetA,targetB,configurations,cases:[],extraChecks:[],evidence:[] };
  const persist = () => fs.writeFileSync(path.join(out,'collaboration-progress.json'),JSON.stringify(report.collaboration,null,2));
  const shot = async name => { const image = await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}); fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(image.data,'base64')); };
  const api = (method, input) => evaluate(`window.api.botWork.${method}(${JSON.stringify(input)})`);
  const relations = async () => (await api('collaborations',{botId:sourceBotId,limit:100})).items;
  const allWorks = () => evaluate('window.api.botWork.listWorks(true)');
  const terminalAnswer = async text => {
    let answer, user;
    await until(async () => {
      const current = await history(); user = current.messages.findLast(message=>message.role==='user'&&message.text===text);
      answer = user && current.messages.find(message=>message.role==='assistant'&&message.requestId===user.requestId);
      if (answer?.status==='running' && answer.collaborations?.length && !report.collaboration.runningScreenshot) {
        await shot('collaboration-live-running'); report.collaboration.runningScreenshot=true;
      }
      return answer && ['completed','failed','cancelled','unknown'].includes(answer.status);
    }, 'foreground collaboration answer '+text.slice(0,45));
    assert.equal(answer.status,'completed',answer.error||answer.text);
    return {answer,user};
  };
  const submit = async text => { await send(text); return terminalAnswer(text); };
  const relationFrom = (answer, target) => {
    const found = answer.collaborations?.find(item=>item.targetBotId===target);
    assert(found, 'the actual source message has a durable collaboration summary');
    return found;
  };
  const fullJournal = async (collaborationId, endpoint = sourceBotId) => {
    const messages = new Map(), events = new Map(); let cursor, last;
    do {
      last = await api('collaborationHistory',{botId:endpoint,collaborationId,limit:100,...cursor?{cursor}: {}});
      for(const message of last.messages) messages.set(message.messageId,message);
      for(const event of last.events) events.set(event.eventId,event);
      cursor=last.nextCursor;
    } while(cursor);
    return {...last,messages:[...messages.values()].sort((a,b)=>a.ordinal-b.ordinal),events:[...events.values()].sort((a,b)=>a.ordinal-b.ordinal)};
  };
  const waitWork = async (relation, filename, validate, timeoutMs = 240000) => {
    let work, journal;
    const ready = async () => {
      journal=await api('collaborationHistory',{botId:sourceBotId,collaborationId:relation.collaborationId,limit:100});
      const id=journal.collaboration.workId;
      work=id&&await api('getWork',id);
      if (work && work.lifecycle==='closed') return true;
      if (work?.blockers?.some(blocker=>blocker.status==='open')) throw Error('Work blocked: '+JSON.stringify(work.blockers));
      return false;
    };
    const deadline=Date.now()+timeoutMs;
    while(!await ready()) {
      if(Date.now()>deadline)throw Error('timeout: target-owned Work completes '+filename);
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(work.closureConclusion,'succeeded',JSON.stringify(work));
    assert.equal(work.ownerBotId,relation.targetBotId);
    assert(!work.team,'personal collaboration never becomes a team');
    const workspace=relation.targetBotId===targetA?workspaceA:workspaceB;
    if(filename) {
      const output=path.join(workspace,filename);
      assert(fs.existsSync(output),'actual target-workspace file '+output);
      const contents=fs.readFileSync(output,'utf8'); validate?.(contents);
      assert(!fs.existsSync(path.join(sourceWorkspace,filename)),'source workspace remains separate');
      report.collaboration.evidence.push({workId:work.workId,file:output,sha256:crypto.createHash('sha256').update(contents).digest('hex'),contents});
    }
    await until(async()=>{const page=await fullJournal(relation.collaborationId);return page.messages.some(message=>message.kind==='result');},'actual result returned into durable relation');
    return {work,journal:await fullJournal(relation.collaborationId)};
  };
  const runCase = async (type, execute) => {
    const row={type,status:'running',providerOffset:requests.length,startedAt:Date.now()};report.collaboration.cases.push(row);persist();
    try { await execute(row); row.status='passed'; }
    catch(error) { row.status='failed';row.error=String(error.stack||error);console.error(type,error); }
    row.endedAt=Date.now();row.modelCalls=requests.length-row.providerOffset;persist();console.log(JSON.stringify({type,status:row.status,modelCalls:row.modelCalls,error:row.error}));
  };
  let arithmeticRelation, stockRelation, htmlRelation;
  await runCase('arithmetic consultation',async row=>{
    const prompt='请问杉树核算员：19乘23等于多少？让它以自己的身份计算，只读咨询，不创建事项。';
    const {answer,user}=await submit(prompt);row.requestId=user.requestId;
    arithmeticRelation=relationFrom(answer,targetA);row.collaborationId=arithmeticRelation.collaborationId;
    const page=await fullJournal(row.collaborationId);row.journal=page;
    assert(page.messages.some(message=>message.senderBotId===targetA&&message.kind==='reply'&&/437/.test(message.text)),'actual recipient arithmetic reply');
    assert.equal(page.collaboration.workId,null);assert.equal((await allWorks()).length,0);
    assert(page.events.some(event=>event.kind==='started')&&page.events.some(event=>event.kind==='returned'));
    await shot('consultation-returned');
  });
  await runCase('attachment analysis and ask-to-delegate',async row=>{
    assert(arithmeticRelation,'prior actual consultation exists');
    await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setBotAttachments(${JSON.stringify(sourceBotId)},[${JSON.stringify({name:path.basename(fixture),path:fixture})}]))`);
    await until(()=>evaluate(`document.querySelector('.bot-composer .input-attach-chips')?.textContent.includes(${JSON.stringify(path.basename(fixture))})`),'real attachment chip');
    const prompt='把刚才与杉树核算员的那段协作转成由它个人负责的一次性事项，继续同一段记录，不创建团队。请它真实读取我这次附上的CSV，按数量乘单价求总额，在它自己的工作区写 stock-result.json，至少含 total 与每件商品的明细。写后回读核验，再交付文件和结论。';
    const {answer,user}=await submit(prompt);row.requestId=user.requestId;
    stockRelation=relationFrom(answer,targetA);row.collaborationId=stockRelation.collaborationId;
    assert.equal(stockRelation.collaborationId,arithmeticRelation.collaborationId,'ask and delegation share exact durable relation');
    const accepted=await waitWork(stockRelation,'stock-result.json',contents=>assert.equal(JSON.parse(contents).total,166));
    row.work=accepted.work;row.journal=accepted.journal;
    assert.equal((await allWorks()).length,1,'one accepted target-owned Work');
    const requestsWithWork=requests.filter(request=>JSON.stringify(request.messages).includes(accepted.work.workId));
    assert(requestsWithWork.some(request=>request.model===targetModelKey.slice('fixture/'.length)),'Work uses target configured model');
    const nativeWorkRequests=requestsWithWork.filter(request=>request.tools?.some(tool=>tool.function.name==='register_artifact'));
    assert(nativeWorkRequests.length>0,'actual Work execution provider requests recorded');
    row.nativeWorkToolLists=nativeWorkRequests.map(request=>request.tools.map(tool=>tool.function.name));
    assert(row.nativeWorkToolLists.every(names=>!names.some(name=>['conversation_goal_create','conversation_goal_update','conversation_goal_propose_complete'].includes(name))),
      'late-bound Work runtime hides generic interactive goal lifecycle tools');
    assert(JSON.stringify(requestsWithWork).includes('CONFIG_CEDAR_'+seed),'target configuration reaches actual execution');
    assert(user.attachments?.[0].path!==fixture,'source attachment snapshot is host-owned');
    assert(JSON.stringify(accepted.work.originalDelegation).includes(prompt),'actual original request remains in Work evidence');
    await shot('delegated-stock-returned');
  });
  if(stockRelation) await runCase('same-relation visible follow-up',async row=>{
    const before=(await relations()).length, worksBefore=(await allWorks()).length;
    await until(()=>evaluate(`Boolean(document.querySelector('[data-collaboration-id="${stockRelation.collaborationId}"]'))`),'source relation entry point');
    await evaluate(`document.querySelector('[data-collaboration-id="${stockRelation.collaborationId}"]').click()`);
    await until(()=>evaluate('Boolean(document.querySelector(".bot-collaboration-followup textarea"))'),'visible relation follow-up composer');
    const prompt='继续这段协作，问杉树核算员刚才总额166是由哪两个乘法算出的，请它简短解释。只读跟进，不更改事项，不创建新事项。';
    await evaluate('document.querySelector(".bot-collaboration-followup textarea").focus()');await rpc('Input.insertText',{text:prompt});
    await evaluate('document.querySelector(".bot-collaboration-followup button[type=submit]").click()');
    await terminalAnswer(prompt);
    await until(async()=>{const page=await fullJournal(stockRelation.collaborationId);return page.messages.some(message=>message.kind==='reply'&&/17/.test(message.text)&&/23/.test(message.text)&&/166/.test(message.text));},'recipient uses earlier exact Work facts');
    assert.equal((await relations()).length,before);assert.equal((await allWorks()).length,worksBefore);
    row.journal=await fullJournal(stockRelation.collaborationId);await shot('same-relation-followup');
    await evaluate(`document.querySelector('[aria-label="关闭协作记录"]').click()`);
    await until(()=>evaluate('!document.querySelector(".bot-collaboration-view")'),'restored source conversation');
  });
  await runCase('independent second-target translation',async row=>{
    const prompt='请问白桦资料员：把“Please send the invoice tomorrow morning”翻成自然中文，让我看到它的原始回复。这是新的独立只读协作，不是杉树核算员的任务，不创建事项。';
    const {answer,user}=await submit(prompt);row.requestId=user.requestId;
    const relation=relationFrom(answer,targetB);row.collaborationId=relation.collaborationId;row.journal=await fullJournal(relation.collaborationId);
    assert(row.journal.messages.some(message=>message.senderBotId===targetB&&message.kind==='reply'&&/发票/.test(message.text)&&/明天|明早/.test(message.text)));
    assert(row.journal.messages.every(message=>[sourceBotId,targetB].includes(message.senderBotId)),'two targets never mix histories');
    assert.equal(row.journal.collaboration.workId,null);
  });
  await runCase('file-based code review',async row=>{
    const prompt='发起与杉树核算员的一件全新独立个人委托，不复用之前的库存事项。请它在自己的工作区实际读取 average.js，审查传入空数组的问题，写 average-review.md，给出具体原因、修复建议和两个测试例子。只读源码，不修改 average.js。实际写出报告并回读交付，不创建团队。';
    const {answer,user}=await submit(prompt);row.requestId=user.requestId;
    const relation=relationFrom(answer,targetA);row.collaborationId=relation.collaborationId;
    assert.notEqual(relation.collaborationId,stockRelation?.collaborationId,'independent goal creates independent relation');
    const accepted=await waitWork(relation,'average-review.md',contents=>assert(/NaN|0\s*\/\s*0/.test(contents),'actual empty-input defect found'));
    row.work=accepted.work;row.journal=accepted.journal;
    assert(fs.readFileSync(path.join(workspaceA,'average.js'),'utf8').includes(' / values.length'),'read-only source contract preserved');
  });
  await runCase('second-target structured extraction',async row=>{
    const prompt='让白桦资料员负责一件新的独立一次性个人事项：实际读取它工作区的 incident.txt，把 ticket、customer、severity、affectedUsers 提取成 incident-result.json，保留真实工单编号和数字，不猜文件内容。实际写入、回读，并交付文件，不创建团队。';
    const {answer,user}=await submit(prompt);row.requestId=user.requestId;
    const relation=relationFrom(answer,targetB);row.collaborationId=relation.collaborationId;
    const accepted=await waitWork(relation,'incident-result.json',contents=>{const value=JSON.parse(contents);assert.equal(value.ticket,'INC-'+seed);assert.equal(value.severity,'P2');assert.equal(value.affectedUsers,17);});
    row.work=accepted.work;row.journal=accepted.journal;
  });
  await runCase('offline teaching artifact with live amendment and archived origin',async row=>{
    const prompt='请杉树核算员单独负责一个全新一次性个人委托“水循环课堂”：实际读取它工作区 lesson-brief.txt，先创建简短 lesson-outline.md 并登记这份阶段成果，再制作离线可打开的 lesson.html，包含至少六节、约八百中文字、蒸发凝结降水的说明、课堂提问、无障碍阅读说明以及资料要求的课堂标识。简洁排版即可。每个输出都真实写入并回读，最终交付HTML。不联网不发布，不创建团队。';
    const {answer,user}=await submit(prompt);row.requestId=user.requestId;
    htmlRelation=relationFrom(answer,targetA);row.collaborationId=htmlRelation.collaborationId;
    let acceptedWork;
    await until(async()=>{const value=await api('collaborationHistory',{botId:sourceBotId,collaborationId:htmlRelation.collaborationId});acceptedWork=value.work;return Boolean(acceptedWork);},'teaching Work accepted');
    row.acceptedWork=acceptedWork;
    const amend='修改刚才同一件“水循环课堂”原事项，不另建：lesson.html 页首必须增加醒目的“修订R2-'+seed+'”标识，保留之前的内容、课堂标识、离线及只读资料要求。请先查询原事项当前版本后修订。';
    const amendment=await submit(amend);row.amendment=amendment.answer;
    const amended=relationFrom(amendment.answer,targetA);assert.equal(amended.collaborationId,htmlRelation.collaborationId);
    assert.equal(amended.workId,acceptedWork.workId,'amendment retains one Work');
    const oldConversation=(await history()).conversationId;
    await evaluate('document.querySelector(".bot-new-conversation").click()');
    await until(()=>evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent==="归档并开始新对话")'),'archive conversation confirmation');
    await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="归档并开始新对话").click()');
    await until(async()=>(await history()).conversationId!==oldConversation,'new source conversation');
    const nextConversation=(await history()).conversationId;
    const accepted=await waitWork(htmlRelation,'lesson.html',contents=>{assert(contents.includes('CLOUD_'+seed));assert(contents.includes('修订R2-'+seed));assert(/蒸发/.test(contents)&&/凝结/.test(contents)&&/降水/.test(contents));},600000);
    row.work=accepted.work;row.journal=accepted.journal;
    assert.equal(accepted.journal.collaboration.sourceConversationId,oldConversation);
    assert(!(await history()).messages.some(message=>message.workFeedback?.workId===accepted.work.workId),'archived-origin result is never redirected into new source conversation');
    const archived=await api('history',{botId:sourceBotId,conversationId:oldConversation});
    assert(archived.messages.some(message=>message.workFeedback?.workId===accepted.work.workId&&message.workFeedback.kind==='result'),'result returns to the original archived conversation');
    row.origin={oldConversation,nextConversation};
    row.partialFacts=accepted.journal.messages.filter(message=>message.kind==='progress'||message.workFeedback?.report?.milestone);
    await shot('archived-origin-delivery');
  });
  const initialCore=report.collaboration.cases.filter(row=>row.type!=='same-relation visible follow-up');
  assert.equal(initialCore.filter(row=>row.status==='passed').length,6,'all six distinct real-model tasks complete before navigation acceptance');
  const works=await allWorks();report.collaboration.works=works;
  assert(works.every(work=>work.ownerBotId===targetA||work.ownerBotId===targetB),'source owns no delegated personal Work');
  assert(works.every(work=>!work.team),'no synthetic team');
  const sourceCount=await api('queryWorks',{scope:{kind:'personal',botId:sourceBotId},view:'all'});
  const aCount=await api('queryWorks',{scope:{kind:'personal',botId:targetA},view:'all'});
  const bCount=await api('queryWorks',{scope:{kind:'personal',botId:targetB},view:'all'});
  assert.equal(sourceCount.total,0);assert.equal(aCount.total+bCount.total,works.length);
  report.collaboration.personalCounts={source:sourceCount.total,targetA:aCount.total,targetB:bCount.total};
  for(const relation of await relations()) {
    const fromSource=await fullJournal(relation.collaborationId),fromTarget=await fullJournal(relation.collaborationId,relation.targetBotId);
    assert.deepEqual(fromSource.messages,fromTarget.messages,'bilateral endpoints share exact logical message identity');
    assert.equal(fromSource.collaboration.messageCount,fromSource.messages.length,'count excludes previews and status events');
    assert.equal(fromSource.totalMessages,fromSource.messages.length);
  }
  const beforeReload=await relations();await rpc('Page.reload');
  await until(()=>evaluate('Boolean(window.api?.botWork?.collaborations&&document.querySelector("#bot-draft"))'),'reloaded collaboration UI');
  assert.deepEqual((await relations()).map(item=>[item.collaborationId,item.workId,item.messageCount]),beforeReload.map(item=>[item.collaborationId,item.workId,item.messageCount]));
  const targetHistory=await api('history',{botId:targetA});
  assert.equal(targetHistory.messages.filter(message=>message.role==='user').length,0,'forwarding never impersonates target-private user turns');
  await until(()=>evaluate('[...document.querySelectorAll(".sidebar-bot-identity")].some(element=>element.querySelector("strong")?.textContent==="杉树核算员")'),'target Bot navigation');
  await evaluate('[...document.querySelectorAll(".sidebar-bot-identity")].find(element=>element.querySelector("strong")?.textContent==="杉树核算员").click()');setBotId(targetA);
  await until(()=>evaluate('document.querySelector(".bot-heading h1")?.textContent==="杉树核算员"'),'target Bot selected');
  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="协作记录").click()');
  await until(()=>evaluate('Boolean(document.querySelector(".bot-collaboration-list [data-collaboration-id]"))'),'target bilateral relation list');
  await evaluate(`document.querySelector('.bot-collaboration-list [data-collaboration-id="${htmlRelation.collaborationId}"]').click()`);
  await until(()=>evaluate('Boolean(document.querySelector(".bot-collaboration-messages"))'),'target bilateral real messages');await shot('target-bilateral-history');
  const htmlCase=report.collaboration.cases.find(item=>item.type==='offline teaching artifact with live amendment and archived origin');
  const htmlDelivery=htmlCase.journal.messages.filter(message=>message.workFeedback?.report?.files?.some(file=>file.name==='lesson.html')).at(-1);
  const returnedFile=htmlDelivery?.workFeedback.report.files.find(file=>file.name==='lesson.html');
  assert(returnedFile?.openPath,'returned HTML has an actual saved snapshot');
  const savedHtml=fs.readFileSync(returnedFile.openPath,'utf8');
  const document=require('linkedom').parseHTML(savedHtml).document;
  assert(document.querySelector('html')&&document.querySelector('body'),'saved HTML parses as a full document');
  assert(document.body.textContent.includes('CLOUD_'+seed)&&document.body.textContent.includes('修订R2-'+seed));
  assert(![...document.querySelectorAll('[src],[href]')].some(element=>/^https?:\/\/|^\/\//.test(element.getAttribute('src')||element.getAttribute('href')||'')),'HTML uses offline resources');
  const expectedTitle=document.querySelector('title')?.textContent.trim()||'lesson.html';
  await evaluate('[...document.querySelectorAll(".bot-collaboration-work button")].find(button=>button.textContent.trim()==="查看事项").click()');
  await until(()=>evaluate(`Boolean(document.querySelector('.bot-work-details .bot-result-files button[aria-label="打开 lesson.html"]'))`),'official saved HTML file button');
  const openButton=await evaluate(`(()=>{const button=document.querySelector('.bot-work-details .bot-result-files button[aria-label="打开 lesson.html"]');for(let ancestor=button.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS'&&!ancestor.open)ancestor.querySelector(':scope>summary')?.click();button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();return {text:button.textContent,x:rect.x+rect.width/2,y:rect.y+rect.height/2,visible:rect.width>0&&rect.height>0&&button.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))};})()`);
  assert(openButton.visible&&openButton.text==='打开保存版本','saved-version button is visible and hit-testable');
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:openButton.x,y:openButton.y,button:'left',clickCount:1});
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:openButton.x,y:openButton.y,button:'left',clickCount:1});
  const auditFile=path.join(out,'official-file-open.jsonl');
  const openAudit=()=>fs.existsSync(auditFile)?fs.readFileSync(auditFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  await until(()=>openAudit().some(event=>event.phase==='completed'&&event.target===returnedFile.openPath),'official file-open IPC completed after actual shell.openPath');
  assert(!openAudit().some(event=>event.phase==='failed'&&event.target===returnedFile.openPath));
  let osWindows=[];
  if(process.platform==='win32') {
    for(let attempt=0;attempt<8&&!osWindows.length;attempt++) {
      const raw=cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
        '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.ProcessName -match "chrome|msedge|firefox|brave|opera" } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true,timeout:3000});
      const values=raw.trim()?JSON.parse(raw):[];
      osWindows=(Array.isArray(values)?values:[values]).filter(window=>window.MainWindowTitle.includes(expectedTitle));
      if(!osWindows.length)await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  report.collaboration.officialFileOpen={snapshotPath:returnedFile.openPath,expectedTitle,
    digest:crypto.createHash('sha256').update(savedHtml).digest('hex'),apiTrace:openAudit(),
    offlineDomVerified:true,osWindows,osLaunchIdentityVerified:osWindows.length>0,
    ...(osWindows.length?{}:{limitation:'Official shell.openPath completed; matching external browser window identity was not observable.'})};
  await shot('official-saved-html-open');
  report.collaboration.extraChecks.push('owner counts, two isolated target workspaces/models/configurations, no team, exact shared logical counts, bilateral history, reload, no fake recipient user turns');
  persist();
  const core=report.collaboration.cases.filter(row=>row.type!=='same-relation visible follow-up');
  assert.equal(core.length,6);
  assert.equal(core.filter(row=>row.status==='passed').length,6,'all six semantically distinct real-model tasks pass');
  assert(report.collaboration.cases.every(row=>row.status==='passed'),'same-relation follow-up and controls pass');
  report.checks.push('six distinct real-model collaboration tasks through visible Electron composer, same-relation ask/delegate/follow-up, target-owned Work/files/model/config, two targets, live amendment, archived-origin return, counts and reload');
};
