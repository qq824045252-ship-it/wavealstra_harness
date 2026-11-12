/** Eleven user-facing request categories, real inference and real tools. Local source inputs are synthetic. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,rawUsageAudit,out,home,modelKey,botId,restart})=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const workspace=path.join(home,'scheduling-inputs');fs.mkdirSync(workspace,{recursive:true});
  const source=path.join(workspace,'source.txt'),brief=path.join(workspace,'brief.md');
  const actionFixtures=seedActionFixtures(workspace);
  const agents=path.join(home,'.mybuddy','agents');fs.mkdirSync(agents,{recursive:true});fs.writeFileSync(path.join(agents,'reader.md'),'---\nname: reader\ndescription: Execute isolated acceptance file tasks using real read/write/bash.\n---\nFollow the delegated file task precisely. Use real tools. Report output paths and exact readback evidence.\n');
  fs.writeFileSync(source,'SOURCE-V1: launch date pending\n');
  fs.writeFileSync(path.join(workspace,'sales.csv'),'product,units,price\nTea,3,12\nCoffee,2,25\nCake,4,8\n');
  const prSource=path.join(workspace,'pr-merge.json'),benchmark=path.join(workspace,'benchmark.json'),benchmarkRuns=path.join(workspace,'benchmark-runs.jsonl');
  const prBaseline={pr:27,version:'PR-V1',merged:false,samples:[7,11,13],controlledDelayMs:0},prMerged={...prBaseline,version:'PR-V2',merged:true};
  const prBaselineText=JSON.stringify(prBaseline)+'\n',prMergedText=JSON.stringify(prMerged)+'\n';
  fs.writeFileSync(prSource,prBaselineText);
  fs.writeFileSync(path.join(workspace,'benchmark.cjs'),`const fs=require('node:fs'),path=require('node:path');const input=JSON.parse(fs.readFileSync(path.join(__dirname,'pr-merge.json'),'utf8'));if(input.merged!==true)throw Error('PR has not merged');const samples=[];let checksum=0;for(let run=0;run<3;run++){const start=process.hrtime.bigint();checksum=0;for(let i=0;i<200000;i++)for(const x of input.samples)checksum+=x;if(input.controlledDelayMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,input.controlledDelayMs);samples.push(Number(process.hrtime.bigint()-start)/1e6);}const elapsedMs=[...samples].sort((a,b)=>a-b)[1];const basePath=path.join(__dirname,'benchmark-baseline.json');let baseline=fs.existsSync(basePath)?JSON.parse(fs.readFileSync(basePath,'utf8')):null;const result={sourceVersion:input.version,iterations:200000,checksum,elapsedMs,samples,controlledDelayMs:input.controlledDelayMs||0,baselineMs:baseline?.elapsedMs??elapsedMs,regression:!!baseline&&elapsedMs>Math.max(baseline.elapsedMs*3,50),runAt:new Date().toISOString(),scope:'Synthetic local workload; not user product performance'};if(!baseline)fs.writeFileSync(basePath,JSON.stringify(result,null,2));fs.writeFileSync(path.join(__dirname,'benchmark.json'),JSON.stringify(result,null,2));fs.appendFileSync(path.join(__dirname,'benchmark-runs.jsonl'),JSON.stringify(result)+'\\n');console.log(JSON.stringify(result));`);

  const works=()=>evaluate('window.api.botWork.listWorks(true)');
  const detail=id=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
  const jobs=()=>evaluate('window.api.cron.list()');
  const notes=()=>evaluate('window.api.notification.list({limit:100})');
  const readWatchProof=workId=>JSON.parse(cp.execFileSync('python3',['-c',`
import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
rows=[]
for row in c.execute("SELECT b.binding_id,b.task_id,b.status,b.admitted_at,b.settled_at,b.intent_revision,b.input_snapshot_id,b.owner_epoch,e.source,e.event_type,e.payload_json,r.state review_state,r.context_json,r.decision_json,r.attempts,r.error FROM work_execution_bindings b LEFT JOIN work_events_inbox e ON e.event_id=b.inbox_event_id OR (b.inbox_event_id IS NULL AND e.work_id=b.work_id AND e.source='file' AND e.source_version=b.input_snapshot_id AND e.received_at<=b.admitted_at) LEFT JOIN work_watch_reviews r ON r.binding_id=b.binding_id WHERE b.work_id=? ORDER BY b.admitted_at",(sys.argv[2],)):
 d=dict(row)
 for key in ['payload_json','context_json','decision_json']:
  d[key]=json.loads(d[key]) if d[key] else None
 d['result_notifications']=[dict(r) for r in c.execute("SELECT f.message_id,f.metadata_json FROM bot_work_feedback f WHERE json_extract(f.metadata_json,'$.executionId')=? AND json_extract(f.metadata_json,'$.kind')='result'",(d['binding_id'],))]
 rows.append(d)
print(json.dumps(rows))
`,path.join(home,'.mybuddy','app.db'),workId],{encoding:'utf8',maxBuffer:8*1024*1024}));
  const readFileInbox=workId=>JSON.parse(cp.execFileSync('python3',['-c',"import sqlite3,json,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute(\"SELECT event_id,source_event_id,source_version,status,payload_json FROM work_events_inbox WHERE work_id=? AND source='file' ORDER BY received_at\",(sys.argv[2],))]))",path.join(home,'.mybuddy','app.db'),workId],{encoding:'utf8'}));
  report.workspace=workspace;report.actionFixtures=actionFixtures;report.cases=[];report.failures=[];report.evidence=[];
  report.artifactObservations=[];
  const seenContents=new Map();const artifactWatch=setInterval(()=>{for(const name of ['partial-a.txt','execution.txt','brief.md','scheduled-check.txt','benchmark.json','mixed-history/diagnosis.json','mixed-history/verification.json','continuous-render/measurements.csv']){const file=path.join(workspace,name);if(!fs.existsSync(file))continue;const content=fs.readFileSync(file,'utf8');if(seenContents.get(name)!==content){seenContents.set(name,content);report.artifactObservations.push({name,at:Date.now(),content});}}},100);artifactWatch.unref();
  report.coverage={real:'Electron pnpm dev, isolated HOME, real online model/tool calls, persisted Work/reminder, local artifact',simulated:'Local source.txt data and controlled real tool wait; no external provider event coverage',restart:'not-run',externalEventSource:'not-tested'};
  const persist=()=>{report.checkpointAt=Date.now();report.modelCalls=requests.length;report.actualModels=[...new Set(requests.map(r=>r.model))];fs.writeFileSync(path.join(out,'scheduling-progress.json'),JSON.stringify(report,null,2));};
  const request=async prompt=>{await send(prompt);const user=(await history()).messages.filter(m=>m.role==='user').at(-1);assert(user?.requestId);await until(async()=>(await history()).messages.some(m=>m.role==='assistant'&&m.requestId===user.requestId&&['completed','failed','cancelled','unknown'].includes(m.status)),'exact foreground request '+user.requestId);const answer=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===user.requestId);return {user,answer};};
  const check=(condition,label,data)=>{report.evidence.push({label,passed:Boolean(condition),data});if(!condition)report.failures.push(label);persist();};
  const section=async(name,fn)=>{try{await fn();}catch(e){report.failures.push(name+': '+String(e.message||e));report.evidence.push({label:name,passed:false,error:String(e.stack||e)});persist();}};
  const owner=(await evaluate('window.api.botWork.listBots()')).find(b=>b.botId===botId);
  assert((await evaluate(`window.api.botWork.updateWorkspaceAuthorization(${JSON.stringify({botId,expectedUpdatedAt:owner.updatedAt,allowWorkspaceFiles:true,confirmNewWorksOnly:true})})`)).ok);
  const settings=(await evaluate(`window.api.botWork.getSettings(${JSON.stringify(botId)})`)).settings;
  assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
  const install=()=>evaluate(`(()=>{
    window.__scheduleUnsubscribe?.();window.__scheduleDomObserver?.disconnect();
    window.__scheduleEvents=[];window.__scheduleDomSamples={};let pending=false,readingFeedback=false;
    const discoverFeedback=()=>{if(readingFeedback||![...document.querySelectorAll('[data-message-id]')].some(el=>el.dataset.messageId.startsWith('work-feedback-')&&!window.__scheduleDomSamples[el.dataset.messageId]))return;readingFeedback=true;window.api.botWork.history({botId:${JSON.stringify(botId)}}).then(h=>{for(const m of h.messages){if(m.role!=='assistant'||!m.workFeedback||window.__scheduleDomSamples[m.messageId])continue;window.__scheduleDomSamples[m.messageId]={messageId:m.messageId,requestId:m.requestId,firstHostObservedAt:Date.now(),observationKind:'history-read-after-DOM-mutation',persistedCreatedAt:m.createdAt,lastPersistedUpdatedAt:m.updatedAt,workFeedback:m.workFeedback};}scan();}).finally(()=>{readingFeedback=false;});};
    const laidOut=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
    const inViewport=el=>{const r=el.getBoundingClientRect();return laidOut(el)&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;};
    const scan=()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;discoverFeedback();
      for(const row of Object.values(window.__scheduleDomSamples)){const article=document.querySelector('[data-message-id="'+row.messageId+'"]');if(!article)continue;
        const body=article.querySelector('.bot-result-body')||article.querySelector('.bot-assistant-content');
        if(body){const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let n;const texts=[];let layout=false,viewport=false;
          while(n=walker.nextNode()){const p=n.parentElement;if(!n.textContent.trim()||p.closest('.bot-reply-placeholder,.bot-tool-activity,[role="status"],.bot-reply-segment-receipt,[data-segment-kind="receipt"],[data-segment-kind="commentary"],button,summary,.bot-message-metrics'))continue;texts.push(n.textContent.trim());layout ||= laidOut(p);viewport ||= inViewport(p);}
          if(texts.length){row.firstBodyPresentAt ||= Date.now();row.firstBodyText ||= texts.join(' ').slice(0,500);if(layout)row.firstBodyLaidOutAt ||= Date.now();if(viewport)row.firstBodyViewportAt ||= Date.now();}
        }
        const buttons=[...article.querySelectorAll('button[aria-label^="打开 "]')];if(buttons.length){row.firstFileButtonPresentAt ||= Date.now();if(buttons.some(laidOut))row.firstFileButtonLaidOutAt ||= Date.now();if(buttons.some(inViewport))row.firstFileButtonViewportAt ||= Date.now();row.fileButtons=buttons.map(b=>b.getAttribute('aria-label'));}
      }
    });};
    window.__scheduleUnsubscribe=window.api.botWork.onMessageChanged(e=>{const m=e.message,at=Date.now();window.__scheduleEvents.push({at,messageId:m.messageId,requestId:m.requestId,role:m.role,status:m.status,text:m.text,segments:m.segments,activity:m.activity,workIds:m.workIds,workFeedback:m.workFeedback,createdAt:m.createdAt,updatedAt:m.updatedAt});
      if(m.role==='assistant'){const row=window.__scheduleDomSamples[m.messageId] ||= {messageId:m.messageId,requestId:m.requestId,firstHostObservedAt:at,persistedCreatedAt:m.createdAt};row.lastPersistedUpdatedAt=m.updatedAt;row.workFeedback=m.workFeedback;if(m.segments?.some(s=>s.kind==='answer'&&s.text?.trim())||m.status==='completed'&&m.text?.trim())row.firstAnswerHostObservedAt ||= at;scan();}
    });
    window.__scheduleDomObserver=new MutationObserver(scan);window.__scheduleDomObserver.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});document.addEventListener('scroll',scan,true);return true;
  })()`);
  await install();
  // Submit all eleven request cases before assertions: failure in one must not silently reduce the batch to one type.
  const scheduledAt=Date.now()+120000;report.scheduledRequestedAt=scheduledAt;
  report.issueCategories={direct:'direct',realtime:'weather',status:'query',lightweightOperation:'reminder reschedule',analysis:'analysis-A',execution:'execution-B',reminder:'reminder',scheduled:'scheduled-execution',event:'file-event',continuous:'continuous-action',mixed:'mixed-request'};
  const specs=[
    {id:'mixed-request',type:'mixed-direct-execution-reminder',prompt:`同一请求请一起处理三件事：先直接告诉我23+19是多少；然后检查 ${actionFixtures.mixed} 中原始 records.json 是否仍在，以及为什么历史检索 history-token-original 找不到。请建立后台委托“验收混合历史检索”，先真实read并运行 node check.cjs diagnose 交付第一批 diagnosis.json 证据，再判断能修就修 search.cjs，执行 node check.cjs verify 回读verification.json；不要修改records.json或check.cjs，不要编造诊断。另独立设置2分钟后提醒“查看混合检索结果”，名称“混合请求提醒”，提醒不替代修复。这三个动作属于这条请求，不取消其他委托。`},
    {id:'continuous-action',type:'continuous-real-optimization',prompt:`建立持续行动目标，标题“验收持续首屏优化”。这是 ${actionFixtures.continuous} 中的本地合成mini DOM测试，不是用户产品性能。现在就startImmediately真实行动，continuous模式，不预造cron。先read代码并真实执行 node measure.cjs baseline；优化renderer.js中O(n²)查找慢点，保持8000条原始记录不丢，再真实执行 node measure.cjs optimized，把真实前后测量追加到同一个measurements.csv。然后继续独立的无障碍步骤：检查实际结果是否accessible，修复renderer使root为role=list、各项role=listitem，再执行 node measure.cjs accessible；不要把第一步结束当整个持续目标结束。不得修改measure.cjs、measure-electron.cjs或records.json，不得手写测量数据。完成当前可行动步骤后，确实需要新的DATA-V2输入才再测：请预先以真实file来源绑定 ${path.join(actionFixtures.continuous,'version.json')}（current_condition允许现在行动），之后等待它的真实变化事件，不要cron轮询或sleep。来源变为DATA-V2后回读新records并执行 node measure.cjs version2，追加同一表、交付更新版本。中途我问天气不应停止这个目标。`},
    {id:'weather',type:'short-realtime-query',prompt:'现在杭州天气怎么样？请用真实联网来源简短查询，附来源和查询时间；这是一个短问题，不创建Work，不修改或停止其他持续目标。查不到就明确说未验证，不编造天气。'},

    {id:'execution-B',type:'execution',prompt:'建立独立一次性后台委托，标题“验收历史读取修复B”。必须调用一次 subagent 工具 tasks 并行派发两个 reader，isolation=shared，cwd 为当前工作区。快子任务A立即写 partial-a.txt 为 A-READY 并回读；慢子任务B先写 execution.txt 为 B-ORIGINAL，然后真实 bash sleep 90，再 read 回读。两个子任务同时开始。A先完成就向我交付可用阶段成果，不要等B。禁止把整个并行调用替换成自己串行做，也不能模拟工具结果。最终交付两份文件。不要联网。'},
    {id:'analysis-A',type:'analysis',prompt:'建立独立一次性后台委托，标题“验收分析A”。立即真实读取 sales.csv，计算总销售额和最高收入产品，写 analysis.csv（含各产品收入与总计），回读交付。不要等待其他任务。'},
    {id:'direct',type:'direct-answer',prompt:'直接计算 137×29，只回答结果，不用工具，不创建任务。'},
    {id:'query',type:'short-current-state-query',prompt:'请查询当前正在进行的委托，用两句话告诉我验收分析A和验收历史读取修复B的真实当前状态。只查询，不等待、不修改或取消。'},
    {id:'reminder',type:'independent-reminder',prompt:'5分钟后提醒我“检查验收结果”，提醒名称“调度验收提醒”。仅到时发提醒，不执行任务，不创建Work。'},
    {id:'scheduled-execution',type:'one-time-scheduled-execution',expectedAt:scheduledAt,prompt:`约两分钟后，在 ${new Date(scheduledAt).toISOString()}（UTC）实际执行一次独立委托，标题“验收定时读取”。到时真实读取 ${source}，把读取到的完整原文写到当前工作区 scheduled-check.txt，真实回读并交付文件。现在不要读取或写入，这是一次定时执行，不是提醒，不循环，也不要用 sleep 代替定时安排。`},
    {id:'file-event',type:'file-event-triggered-benchmark',prompt:`建立事件驱动持续委托，标题“验收PR合并benchmark”。这里 ${prSource} 是测试用PR状态文件，不是真实GitHub webhook。请先查询已接入的事件来源，使用真实 file 事件源、eventTarget 为这个规范绝对路径，triggerMode=next_event，executionMode=continuous，catchUpPolicy=latest，notificationMode=changes_only，notifyInitial=true；不配置cron轮询，不在创建时执行。今后收到该文件的真实变化事件后，实际读取文件；如果 merged=true，对当前来源版本实际执行一次 node benchmark.cjs（当前工作区已有脚本），实际回读 benchmark.json 并交付，首个合并事件的真实benchmark必须交付作为实测基线；后续每个新版本仍实际执行并回读登记 benchmark.json，但只有结果 regression=true 才通知我，regression=false 时静默，不发普通结果通知。脚本会实测三次中位数，阈值为基线三倍与50ms中较大者；数据中的controlledDelayMs是明确标注的本地受控回归负载，不是真实产品性能。相同来源内容/相同版本重复写入不要重复运行。不要修改 benchmark.cjs、不要自行伪造benchmark输出，不联网。保持等待后续事件，不要第一轮后结束。`},
    {id:'ongoing',type:'ongoing-goal',prompt:`建立持续执行目标，标题“验收持续简报”。现在先真实读取 ${source} 并立即写 ${brief}，做一个简短状态摘要（含原始版本标记）。完成本轮后再等后续变化，每分钟检查同一来源，只在来源发生变化时更新同一个 brief.md 并交付新版本，内容未变时静默。每轮都实际回读并登记当前 brief.md 的文件快照，即使来源不变也只登记相同文件、不改写内容，用真实快照核对成果仍然有效。新聊天问题不应停止该目标。使用真实文件工具，不要联网，不要只设置等待然后不做首轮，不要因首轮完成而结束目标。`},
  ];
  for(const s of specs){const row={...s,submittedAt:Date.now(),providerOffset:requests.length,status:'submitted'};report.cases.push(row);await send(s.prompt);row.user=(await history()).messages.filter(m=>m.role==='user').at(-1);persist();}
  const completed=async row=>{await until(async()=>{row.answer=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===row.user.requestId);return row.answer&&['completed','failed','cancelled','unknown'].includes(row.answer.status);},row.id+' foreground');row.foregroundObservedAt=Date.now();row.status=row.answer.status;persist();};
  // An amendment is made while B's actual sleep tool keeps the original execution in flight.
  let a,b,ongoing,eventWork;
  await section('S1 concurrent works and amendment',async()=>{
    await until(async()=>{const rows=await works();a=rows.find(w=>w.title==='验收分析A');b=rows.find(w=>w.title==='验收历史读取修复B');return a&&b;},'two named independent Works');
    report.beforeAmend={a:await detail(a.workId),b:await detail(b.workId),observedAt:Date.now()};
    report.responsivenessProbes=[];
    for(let i=0;i<8;i++){const rows=await works(),prompt=i%2===0?`并发响应样本${i+1}：当前有多少个Work仍在运行？只查真实当前状态，一句话回答，不停止、不修改任何任务。`:`并发响应样本${i+1}：只回答${31+i}+7的结果，不调用工具，也不停止或修改其他任务。`;
      const probe={index:i,prompt,submittedAt:Date.now(),runningWorkIds:rows.filter(w=>w.executions?.some(e=>e.status==='running')).map(w=>w.workId)};report.responsivenessProbes.push(probe);await send(prompt);probe.user=(await history()).messages.filter(m=>m.role==='user').at(-1);persist();}

    await until(async()=>{const w=await detail(b.workId);report.inflightMilestoneWork=w;return (await history()).messages.some(m=>m.role==='assistant'&&m.workIds?.includes(b.workId)&&m.workFeedback?.eventId?.startsWith('milestone:')&&/A-READY|partial-a/.test(m.text));},'actual parallel A milestone while B tool remains pending');
    report.parallelPartial={at:Date.now(),work:await detail(b.workId),messages:(await history()).messages.filter(m=>m.role==='assistant'&&m.workFeedback?.eventId?.startsWith('milestone:')&&m.workIds?.includes(b.workId)&&/A-READY|partial-a/.test(m.text))};
    check(report.parallelPartial.work.executions.some(e=>e.status==='running'),'S1 actual parallel A milestone before Work execution terminal');
    const binding=report.parallelPartial.work.executions.find(e=>e.status==='running');
    report.parallelPartial.nativeHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(binding.taskId)})`);
    report.parallelPartial.children=await evaluate(`window.api.subagent.active(${JSON.stringify(binding.taskId)})`);
    check(report.parallelPartial.children.some(c=>c.status==='running'),'S1 real child still running at partial delivery');
    const partialFiles=report.parallelPartial.work.phase3.milestones.ready.filter(m=>m.bindingId===binding.bindingId).flatMap(m=>m.files||[]);
    report.parallelPartial.queryTurn=await request('查询验收历史读取修复B当前已经可用的阶段成果和仍在进行的子任务，基于最新状态简短回答，不要停止、重跑或改写任务。');
    report.parallelPartial.currentStateQuery=report.parallelPartial.queryTurn.answer;
    check(/A-READY|partial-a/.test(report.parallelPartial.currentStateQuery?.text||''),'S1 current-state query includes completed A evidence');
    report.parallelPartial.snapshotFiles=partialFiles.map(f=>({...f,exists:!!f.openPath&&fs.existsSync(f.openPath),content:f.openPath&&fs.existsSync(f.openPath)?fs.readFileSync(f.openPath,'utf8'):null}));
    check(report.parallelPartial.snapshotFiles.some(f=>f.name==='partial-a.txt'&&f.exists&&f.content.includes('A-READY')),'S1 real readable immutable partial snapshot');
    const partialMessage=report.parallelPartial.messages.find(m=>m.workFeedback?.eventId?.startsWith('milestone:'));
    if(partialMessage){const selector='[data-message-id="'+partialMessage.messageId+'"]';const target=partialFiles.find(f=>f.name==='partial-a.txt')?.openPath;await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);await wait(200);
      report.parallelPartial.ui=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const button=el?.querySelector('button[aria-label="打开 partial-a.txt"]');const link=[...(el?.querySelectorAll('a')||[])].find(a=>a.href.includes(${JSON.stringify(target||'NO_VALID_SNAPSHOT')}));const action=button||link;if(action)action.click();return {clicked:!!action,text:el?.innerText,buttons:[...(el?.querySelectorAll('button')||[])].map(b=>b.getAttribute('aria-label')||b.innerText)};})()`);
      await wait(300);report.parallelPartial.ui.error=await evaluate(`document.querySelector(${JSON.stringify(selector)})?.querySelector('[role=alert]')?.innerText||''`);check(report.parallelPartial.ui.clicked&&!report.parallelPartial.ui.error,'S1 real partial UI open control succeeds');const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'partial-a-ui.png'),Buffer.from(shot.data,'base64'));}

  });
  await section('S1 semantic amendment independent of milestone outcome',async()=>{
    assert(a&&b,'both Work identities available for amendment');
    const prompt='这轮只修历史读取：最终 execution.txt 必须为 B-AMENDED，替换原来的 B-ORIGINAL。验收分析A和验收持续简报都继续，不要取消或改变它们。';
    report.amendment={submittedAt:Date.now(),prompt,beforeWorkIds:(await works()).map(w=>w.workId)};report.amendment.turn=await request(prompt);
    report.amendment.createdWorkIds=(await works()).map(w=>w.workId).filter(id=>!report.amendment.beforeWorkIds.includes(id));
    check(!report.amendment.createdWorkIds.length,'S1 amendment creates no replacement Work');
    report.amendment.after={a:await detail(a.workId),b:await detail(b.workId),at:Date.now()};
    check(report.amendment.after.b.intentRevision>report.beforeAmend.b.intentRevision,'S1 amendment changes B intent');
    check(report.amendment.after.a.intentRevision===report.beforeAmend.a.intentRevision,'S1 amendment does not change A intent');
    await until(async()=>(await history()).messages.some(m=>m.workIds?.includes(a.workId)&&['result','decision'].includes(m.workFeedback?.category)),'A usable result');
    report.firstA={at:Date.now(),b:await detail(b.workId),messages:(await history()).messages.filter(m=>m.workIds?.includes(a.workId)&&['result','decision'].includes(m.workFeedback?.category))};
    check(report.firstA.b.executions.some(e=>['running','pending','queued','admitted'].includes(e.status)),'S1 A result available while B continues');
  });
  for(const row of report.cases)await section(row.id,()=>completed(row));
  check(new Set(report.cases.map(c=>c.type)).size>=6,'minimum six different task types submitted');
  check(report.cases.find(c=>c.id==='direct').answer?.text.includes('3973'),'direct answer arithmetic');
  const query=report.cases.find(c=>c.id==='query');report.querySnapshot={at:query.foregroundObservedAt,answer:query.answer,works:await works()};
  await section('S1 final snapshot',async()=>{
    assert(a&&b,'both Work identities');
    await until(async()=>{const w=await detail(b.workId);report.latestB=w;return w.lifecycle==='closed';},'B final');
    const aw=await detail(a.workId),bw=await detail(b.workId);report.finalAB={a:aw,b:bw,at:Date.now()};
    check(bw.closureConclusion==='succeeded','S1 B successful closure');
    check(fs.existsSync(path.join(workspace,'execution.txt'))&&fs.readFileSync(path.join(workspace,'execution.txt'),'utf8').trim()==='B-AMENDED','S1 latest amended artifact on disk');
    const result=(await history()).messages.findLast(m=>m.workIds?.includes(b.workId)&&m.workFeedback?.report?.completion?.nextStep==='deliver');
    report.finalBDelivery=result;
    const files=result?.workFeedback?.report?.files||[];
    check(files.some(f=>f.name==='execution.txt'&&f.openPath&&fs.existsSync(f.openPath)&&fs.readFileSync(f.openPath,'utf8').trim()==='B-AMENDED'),'S1 delivered immutable snapshot is latest amendment');
    check(aw.closureConclusion==='succeeded','S1 analysis successful');
  });
  await section('S1 mixed original records diagnosis repair and reminder',async()=>{
    const row=report.cases.find(c=>c.id==='mixed-request'),work=(await works()).find(w=>w.title==='验收混合历史检索');assert(work,'mixed request Work exists');
    await until(()=>fs.existsSync(path.join(actionFixtures.mixed,'verification.json')),'real mixed diagnosis and repair verification');
    const diagnosis=JSON.parse(fs.readFileSync(path.join(actionFixtures.mixed,'diagnosis.json'),'utf8')),verification=JSON.parse(fs.readFileSync(path.join(actionFixtures.mixed,'verification.json'),'utf8'));
    const operations=JSON.parse(cp.execFileSync('python3',['-c',"import sqlite3,json,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(json.dumps([{'operationId':r[0],'result':json.loads(r[1])} for r in c.execute('SELECT operation_id,result_json FROM cron_reminder_operations WHERE operation_id LIKE ?',('%:'+sys.argv[2]+':%',))]))",path.join(home,'.mybuddy','app.db'),row.user.requestId],{encoding:'utf8'}));
    report.mixed={requestId:row.user.requestId,answer:row.answer,work:await detail(work.workId),diagnosis,verification,reminderOperations:operations};
    check(/42/.test(row.answer?.text||''),'mixed immediate direct answer');
    check(report.mixed.work.originalDelegation.messages.some(m=>m.messageId===row.user.messageId),'mixed Work linked to same original user message');
    check(operations.some(o=>o.result?.reminder?.title==='混合请求提醒'||JSON.stringify(o.result).includes('混合请求提醒')),'mixed reminder action linked to same original request');
    check(diagnosis.recordCount===12&&diagnosis.expectedIds.includes(1)&&diagnosis.actualIds.length===0&&!diagnosis.passed,'S1 first real evidence shows records intact and historical query broken');
    check(verification.passed&&verification.actualIds.includes(1),'S1 model actually repaired historical lookup');
    check(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(actionFixtures.mixed,'records.json'))).digest('hex')===actionFixtures.mixedRecordsDigest,'S1 original records preserved unchanged');
    const first=report.artifactObservations.find(o=>o.name==='mixed-history/diagnosis.json'),last=report.artifactObservations.find(o=>o.name==='mixed-history/verification.json');check(first&&last&&first.at<=last.at,'S1 diagnostic evidence precedes repaired verification');
  });
  await section('short real-time weather',async()=>{
    const row=report.cases.find(c=>c.id==='weather');report.weather={answer:row.answer};
    const calls=[...new Map(requests.flatMap(r=>r.messages||[]).flatMap(m=>m.tool_calls||[]).map(c=>[c.id,c])).values()];
    report.weather.searchCalls=calls.filter(c=>c.function?.name==='web_search'&&/杭州|Hangzhou/.test(c.function.arguments));
    check(report.weather.searchCalls.length>0,'real-time weather uses actual search tool');
    check(/https?:\/\//.test(row.answer?.text||''),'real-time weather cites actual source');
    check(!(row.answer?.workIds||[]).length,'short real-time query creates no Work');
  });
  await section('S3 real continuous local renderer optimization',async()=>{
    const work=(await works()).find(w=>w.title==='验收持续首屏优化');assert(work,'continuous-action Work exists');
    const readResult=label=>JSON.parse(fs.readFileSync(path.join(actionFixtures.continuous,label+'-result.json'),'utf8'));
    await until(()=>fs.existsSync(path.join(actionFixtures.continuous,'accessible-result.json')),'actual baseline optimize and independent accessibility step');
    report.continuousAction={work:await detail(work.workId),baseline:readResult('baseline'),optimized:readResult('optimized'),accessible:readResult('accessible'),tableBefore:fs.readFileSync(path.join(actionFixtures.continuous,'measurements.csv'),'utf8'),renderer:fs.readFileSync(path.join(actionFixtures.continuous,'renderer.js'),'utf8')};
    const value=report.continuousAction,median=rows=>rows.map(r=>r.domBuildMs).sort((a,b)=>a-b)[1];
    check(value.work.mode==='watch'&&value.work.lifecycle==='active','S3 continuous action remains active after current steps');
    check(value.work.phase4.subscriptions.every(sub=>!sub.cronExpression),'S3 optimization is not substituted with cron');
    check(value.baseline.rows.every(r=>r.renderedCount===8000)&&value.optimized.rows.every(r=>r.renderedCount===8000),'S3 actual optimization preserves all original records');
    check(value.renderer!==actionFixtures.rendererOriginal,'S3 model changed real renderer source');
    check(value.accessible.rows.every(r=>r.accessible),'S3 independent accessibility improvement actually verified in DOM');
    check(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(actionFixtures.continuous,'measure.cjs'))).digest('hex')===actionFixtures.measurementScriptDigest,'S3 measurement runner not rewritten by model');
    value.localOnlyTimings={baselineMedianDomMs:median(value.baseline.rows),optimizedMedianDomMs:median(value.optimized.rows),notice:'Three local synthetic DOM measurements per stage, under concurrent test load; not user product performance or network first paint.'};
    check(value.localOnlyTimings.optimizedMedianDomMs<value.localOnlyTimings.baselineMedianDomMs,'S3 measured local bottleneck improved (sample only)');
    check(value.tableBefore.includes('baseline,DATA-V1')&&value.tableBefore.includes('optimized,DATA-V1')&&value.tableBefore.includes('accessible,DATA-V1'),'S3 same measurements table records real independent steps');
    const weather=report.cases.find(c=>c.id==='weather');value.weatherInterruption={requestId:weather.user.requestId,answer:weather.answer};
    check(value.work.lifecycle==='active','S3 unrelated weather did not stop continuous goal');
    const versionPath=path.join(actionFixtures.continuous,'version.json');
    check(value.work.phase4.subscriptions.some(sub=>sub.source==='file'&&sub.status==='online'),'S3 actual later dependency is prebound file source');
    const beforeCount=value.work.executions.length;value.dependencyMutationAt=Date.now();
    fs.writeFileSync(path.join(actionFixtures.continuous,'records.json'),JSON.stringify(Array.from({length:8200},(_,i)=>({id:i,title:'Synthetic record '+i}))));
    fs.writeFileSync(versionPath,JSON.stringify({version:'DATA-V2',ready:true,records:8200}));
    await until(()=>fs.existsSync(path.join(actionFixtures.continuous,'version2-result.json')),'true new-version event resumes same optimization target');
    value.version2=readResult('version2');value.finalWork=await detail(work.workId);value.tableAfter=fs.readFileSync(path.join(actionFixtures.continuous,'measurements.csv'),'utf8');
    check(value.version2.version==='DATA-V2'&&value.version2.rows.every(r=>r.renderedCount===8200),'S3 new real dependency data measured');
    check(value.finalWork.executions.length>beforeCount&&value.tableAfter.startsWith(value.tableBefore),'S3 same Work continues and appends same measurements table');
    await request('暂停验收持续首屏优化，保留全部测试测量和成果，不要取消或修改别的任务。');
    check((await detail(work.workId)).lifecycle==='paused','S3 explicit pause after continuous-action acceptance');
  });
  await section('S2 one-time scheduled real execution',async()=>{
    const scheduled=(await works()).find(w=>w.title==='验收定时读取');assert(scheduled,'scheduled Work created');
    report.scheduledExecution={initial:await detail(scheduled.workId),expectedAt:scheduledAt};
    check(report.scheduledExecution.initial.mode==='watch','S2 timed execution uses scheduled Work mode');
    await until(async()=>{const w=await detail(scheduled.workId);report.scheduledExecution.latest=w;return w.executions.some(e=>e.status==='completed')&&fs.existsSync(path.join(workspace,'scheduled-check.txt'));},'actual clock scheduled read/write completes');
    const w=await detail(scheduled.workId),binding=w.executions.find(e=>e.status==='completed');
    report.scheduledExecution.final=w;report.scheduledExecution.file=fs.readFileSync(path.join(workspace,'scheduled-check.txt'),'utf8');
    report.scheduledExecution.nativeHistory=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(binding.taskId)})`);
    report.scheduledExecution.diagnostics=await evaluate(`window.api.agent.getTaskDiagnostics(${JSON.stringify(binding.taskId)})`);
    report.scheduledExecution.firstFile=report.artifactObservations.find(o=>o.name==='scheduled-check.txt');
    check(binding.admittedAt>=scheduledAt,'S2 scheduled execution admitted after requested real deadline');
    check(report.scheduledExecution.firstFile?.at>=scheduledAt,'S2 no early scheduled artifact');
    check(report.scheduledExecution.file===fs.readFileSync(source,'utf8'),'S2 scheduled output saves actual source contents');
    check(w.executions.length===1,'S2 one scheduled execution only');
    check(w.phase4.subscriptions.every(sub=>!sub.cronExpression&&!sub.nextWakeAt),'S2 one-time schedule has no repeating or pending slot');
    await until(async()=>(await history()).messages.some(m=>m.workIds?.includes(w.workId)&&m.workFeedback?.report?.files?.some(f=>f.name==='scheduled-check.txt')),'scheduled file delivered');
    report.scheduledExecution.delivery=(await history()).messages.findLast(m=>m.workIds?.includes(w.workId)&&m.workFeedback?.report?.files?.some(f=>f.name==='scheduled-check.txt'));
    const file=report.scheduledExecution.delivery.workFeedback.report.files.find(f=>f.name==='scheduled-check.txt');
    check(!!file.openPath&&fs.existsSync(file.openPath)&&fs.readFileSync(file.openPath,'utf8')===report.scheduledExecution.file,'S2 actual delivered scheduled immutable snapshot');
    await section('S2 one-time goal closes after verified delivery',async()=>{await until(async()=>{report.scheduledExecution.finalWork=await detail(w.workId);return report.scheduledExecution.finalWork.lifecycle==='closed';},'one-time scheduled goal settled');check(report.scheduledExecution.finalWork.closureConclusion==='succeeded','S2 one-time scheduled goal closes succeeded');});
    report.coverage.scheduledExecution='real one-time clock, model, native tools, artifact; not push event';
  });
  await section('S2 real file event to benchmark and version dedup',async()=>{
    eventWork=(await works()).find(w=>w.title==='验收PR合并benchmark');assert(eventWork,'file-event Work exists');
    const baselineHash='sha256:'+require('node:crypto').createHash('sha256').update(prBaselineText).digest('hex');
    await until(async()=>{const w=await detail(eventWork.workId);report.fileEvent={...(report.fileEvent||{}),baseline:w};return w.phase4.subscriptions.some(sub=>sub.source==='file'&&sub.status==='online'&&sub.cursors.some(c=>c.enumerationWatermark===baselineHash));},'actual fs.watch receiver attached with authoritative baseline');
    check(report.fileEvent.baseline.executions.length===0&&!fs.existsSync(benchmark),'S2 next_event baseline does not execute benchmark');
    check(report.fileEvent.baseline.phase4.subscriptions.every(sub=>!sub.cronExpression),'S2 file event is not cron polling');
    report.fileEvent.mutation={at:Date.now(),kind:'simulated PR merge data; real fs.watch receiver',before:prBaseline,after:prMerged};fs.writeFileSync(prSource,prMergedText);
    await until(async()=>{const w=await detail(eventWork.workId);report.fileEvent.latest=w;return w.executions.some(e=>e.status==='completed')&&fs.existsSync(benchmark);},'real file change dispatch and benchmark artifact');
    const w=await detail(eventWork.workId);report.fileEvent.completed=w;report.fileEvent.benchmark=JSON.parse(fs.readFileSync(benchmark,'utf8'));report.fileEvent.runs=fs.readFileSync(benchmarkRuns,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    report.fileEvent.ingressProof=readWatchProof(eventWork.workId);
    check(report.fileEvent.ingressProof.some(r=>r.source==='file'&&r.event_type==='file.changed'&&r.payload_json?.observation==='fs-watch'),'S2 actual fs.watch event persisted and dispatched');
    check(report.fileEvent.benchmark.sourceVersion==='PR-V2'&&report.fileEvent.benchmark.checksum===6200000&&Number.isFinite(report.fileEvent.benchmark.elapsedMs),'S2 real benchmark used merged authoritative source');
    check(report.fileEvent.runs.length===1,'S2 one benchmark execution for source version');
    await section('S2 target benchmark JSON registered and delivered',async()=>{
      await until(async()=>(await history()).messages.some(m=>m.workIds?.includes(w.workId)&&m.workFeedback?.report?.files?.some(f=>f.name==='benchmark.json')),'event benchmark file delivered');
      report.fileEvent.delivery=(await history()).messages.findLast(m=>m.workIds?.includes(w.workId)&&m.workFeedback?.report?.files?.some(f=>f.name==='benchmark.json'));
      const file=report.fileEvent.delivery.workFeedback.report.files.find(f=>f.name==='benchmark.json');
      check(!!file.openPath&&fs.existsSync(file.openPath)&&JSON.parse(fs.readFileSync(file.openPath,'utf8')).sourceVersion==='PR-V2','S2 target JSON immutable snapshot opens with actual version');
    });
    const count=w.executions.length,runBytes=fs.readFileSync(benchmarkRuns,'utf8');report.fileEvent.beforeDuplicateInbox=readFileInbox(w.workId);
    fs.writeFileSync(prSource,prMergedText);await wait(1000);fs.writeFileSync(prSource,prMergedText);await wait(5000);
    report.fileEvent.afterDuplicate=await detail(w.workId);report.fileEvent.afterDuplicateInbox=readFileInbox(w.workId);
    check(report.fileEvent.afterDuplicateInbox.length===report.fileEvent.beforeDuplicateInbox.length,'S2 repeated identical source bytes create no extra inbox event');
    check(report.fileEvent.afterDuplicate.executions.length===count&&fs.readFileSync(benchmarkRuns,'utf8')===runBytes,'S2 repeated same authoritative bytes/version does not rerun benchmark');
    for(const [version,delay,expectedSilent] of [['PR-V3',0,true],['PR-V4',100,false]])await section('S2 conditional benchmark '+version,async()=>{
      const before=await detail(w.workId),mutationAt=Date.now();fs.writeFileSync(prSource,JSON.stringify({...prMerged,version,controlledDelayMs:delay})+'\n');
      await until(async()=>{const current=await detail(w.workId);return current.executions.length>before.executions.length&&fs.existsSync(benchmark)&&JSON.parse(fs.readFileSync(benchmark,'utf8')).sourceVersion===version&&current.executions.some(e=>e.admittedAt>=mutationAt&&e.status==='completed');},'actual benchmark version '+version);
      let proof;await until(()=>{proof=readWatchProof(w.workId).findLast(r=>r.admitted_at>=mutationAt);return proof&&['silent','delivered','superseded'].includes(proof.review_state);},'review business condition '+version);
      const result=JSON.parse(fs.readFileSync(benchmark,'utf8'));(report.fileEvent.conditionalVersions ||= []).push({version,mutationAt,result,proof});
      check(result.regression===!expectedSilent,'S2 real benchmark baseline comparison '+version);
      check(expectedSilent?proof.review_state==='silent'&&proof.result_notifications.length===0:proof.review_state==='delivered'&&proof.result_notifications.length>0,'S2 condition-based result visibility '+version);
      check(proof.context_json?.artifactEvidence?.length>0,'S2 current benchmark evidence registered '+version);
    });
    report.coverage.fileEvent='Real fs.watch, authoritative SHA-256 readback, ingress, model/tool dispatch; PR JSON is simulated. Not GitHub webhook.';
  });
  await section('S3 ongoing first action and independent question',async()=>{
    ongoing=(await works()).find(w=>w.title==='验收持续简报');assert(ongoing,'ongoing Work exists');
    await until(()=>fs.existsSync(brief),'initial ongoing artifact');
    report.ongoingInitial={at:Date.now(),work:await detail(ongoing.workId),content:fs.readFileSync(brief,'utf8')};
    check(report.ongoingInitial.content.includes('SOURCE-V1'),'S3 first artifact reflects original source');
    const firstExecution=[...report.ongoingInitial.work.executions].sort((a,b)=>a.admittedAt-b.admittedAt)[0];
    const nextWake=report.ongoingInitial.work.phase4.subscriptions.filter(s=>s.status==='online').map(s=>s.nextWakeAt).filter(Number.isFinite).sort((a,b)=>a-b)[0];
    const immediateRequests=requests.map((r,index)=>({index,text:JSON.stringify(r.messages||[])})).filter(r=>r.text.includes(ongoing.workId)&&/\\?"immediate\\?"\s*:\s*true/.test(r.text));
    report.ongoingInitial.immediateEvidence={firstExecution,nextWake,firstArtifact:report.artifactObservations.find(o=>o.name==='brief.md'),immediateRequestIndices:immediateRequests.map(r=>r.index)};
    check(immediateRequests.length>0,'S3 actual model input contains immediate source event for this Work');
    const firstProof=readWatchProof(ongoing.workId).find(r=>r.binding_id===firstExecution?.bindingId);
    report.ongoingInitial.immediateEvidence.persistedFirstEvent=firstProof;
    check(!!firstExecution&&firstProof?.payload_json?.immediate===true,'S3 initial execution admitted from actual immediate event (not inferred from current schedule)');
    check(report.ongoingInitial.work.lifecycle==='active','S3 first round retains goal');
    await send('另一个不相关的小问题：一小时有多少分钟？直接回答，不要停止或修改任何持续目标。');await foregroundDone();
    check((await detail(ongoing.workId)).lifecycle==='active','S3 short question leaves ongoing goal active');
    await section('S3 real unchanged cron round is host-silent',async()=>{
      let unchanged;
      await until(async()=>{const rows=readWatchProof(ongoing.workId);report.watchReviewProof=rows;
        unchanged=rows.find(r=>r.status==='completed'&&r.source==='cron'&&r.event_type==='work.tick'&&!r.payload_json?.immediate);
        return unchanged&&['silent','delivered','superseded'].includes(unchanged.review_state);},'real second unchanged cron observation and host review');
      report.unchangedRound=unchanged;report.unchangedRound.observedAt=Date.now();
      report.unchangedRound.work=await detail(ongoing.workId);
      check(unchanged.review_state==='silent'&&unchanged.context_json?.reason==='host_proven_unchanged'&&unchanged.context_json?.hostProvenUnchanged===true,'S3 unchanged round persisted host-proven silence', {state:unchanged.review_state,reason:unchanged.context_json?.reason,comparison:unchanged.context_json?.comparisonState});
      check(unchanged.attempts===0&&unchanged.decision_json===null&&!unchanged.error,'S3 unchanged round invokes zero result-review model turns');
      check(unchanged.result_notifications.length===0,'S3 unchanged round emits no result notification');
      check(fs.readFileSync(source,'utf8')==='SOURCE-V1: launch date pending\n','S3 unchanged evidence captured before source mutation');
      const current=report.unchangedRound.work;report.unchangedRound.safeConditions={lifecycle:current.lifecycle,gaps:current.phase3.gaps,nextWakeAt:current.phase4.subscriptions.map(s=>s.nextWakeAt),artifacts:current.generatedArtifacts};
      if(unchanged.context_json?.reason!=='host_proven_unchanged')report.unchangedRound.notEligibleOrFailed={comparisonState:unchanged.context_json?.comparisonState,artifactEvidence:unchanged.context_json?.artifactEvidence,followUpAvailability:unchanged.context_json?.followUpAvailability,notice:'No host proof was established; do not count as silent fast-path acceptance.'};
    });
    fs.writeFileSync(source,'SOURCE-V2: launch date confirmed Friday\n');report.sourceChange={at:Date.now(),kind:'explicit simulated local file input',content:fs.readFileSync(source,'utf8')};
    await until(()=>fs.existsSync(brief)&&fs.readFileSync(brief,'utf8').includes('SOURCE-V2'),'same brief updated from changed source');
    report.ongoingUpdated={at:Date.now(),work:await detail(ongoing.workId),content:fs.readFileSync(brief,'utf8')};
    const currentSection=report.ongoingUpdated.content.split(/^##\s*(变更记录|历史|History)/mi)[0];
    check(currentSection.match(/SOURCE-V[0-9]+/)?.[0]==='SOURCE-V2'&&currentSection.includes(fs.readFileSync(source,'utf8').trim()),'S3 current section identifies V2 and actual source text; explicitly labelled historical V1 is allowed');
    await section('S3 updated brief registered snapshot matches current bytes',async()=>{let file;await until(async()=>{const w=await detail(ongoing.workId);const refs=w.generatedArtifacts||[];file=refs.find(f=>f.name==='brief.md'&&f.openPath&&fs.existsSync(f.openPath)&&fs.readFileSync(f.openPath,'utf8')===fs.readFileSync(brief,'utf8'));if(file)return true;const messages=(await history()).messages;file=messages.flatMap(m=>m.workIds?.includes(ongoing.workId)?m.workFeedback?.report?.files||[]:[]).find(f=>f.name==='brief.md'&&f.openPath&&fs.existsSync(f.openPath)&&fs.readFileSync(f.openPath,'utf8')===fs.readFileSync(brief,'utf8'));return !!file;},'V2 brief current registered immutable snapshot');report.ongoingUpdated.snapshot=file;});
    const conversationId=(await history()).conversationId;report.eventsBeforeRestart=await evaluate('window.__scheduleEvents');report.domBeforeRestart=await evaluate('Object.values(window.__scheduleDomSamples)');
    await restart();await install();report.coverage.restart='real normal Electron restart completed';
    check((await history()).conversationId===conversationId,'restart retains source conversation');
    check((await detail(ongoing.workId)).lifecycle==='active','restart retains ongoing goal');
    await send('暂停验收持续简报，保留现有成果，不要立即再检查。');await foregroundDone();
    check((await detail(ongoing.workId)).lifecycle==='paused','S3 explicit pause works');
  });
  await section('independent normal restart recovery',async()=>{
    if(report.coverage.restart!=='real normal Electron restart completed'){const id=(await history()).conversationId;report.eventsBeforeRestart=await evaluate('window.__scheduleEvents');report.domBeforeRestart=await evaluate('Object.values(window.__scheduleDomSamples)');await restart();await install();report.coverage.restart='real normal Electron restart completed';check((await history()).conversationId===id,'independent restart retains original conversation');}
  });
  // Run reminder delivery after the background jobs settle/are paused, so a strict zero-model delta is meaningful.
  await section('S2 independent reminder reschedule and delivery',async()=>{
    const matches=(await jobs()).filter(j=>j.name==='调度验收提醒');assert.equal(matches.length,1);const job=matches[0];
    const priorWorks=(await works()).map(w=>w.workId),oldDue=job.scheduleExpr;
    const eventBefore=eventWork?await detail(eventWork.workId):null,eventRunBytes=fs.existsSync(benchmarkRuns)?fs.readFileSync(benchmarkRuns,'utf8'):null;
    report.reminderRequest=await request(`把调度验收提醒 ${job.id} 改到从现在起20秒后，保持同一个提醒；同时关联“验收PR合并benchmark”当前已经生成并登记的 benchmark.json 成果，到期把这份已有成果作为可打开文件一并交付。不要到期重跑benchmark，不创建Work，不修改该Work，不用纯文本路径冒充可打开附件。`);
    const after=(await jobs()).filter(j=>j.name==='调度验收提醒');check(after.length===1&&after[0].id===job.id,'S2 reschedule preserves reminder identity');
    report.reminder={id:job.id,oldDue,newDue:after[0]?.scheduleExpr};
    const baseline=requests.length;
    await until(async()=>(await notes()).some(n=>n.sourceId===job.id&&n.type==='reminder.due'&&n.createdAt>=Date.parse(after[0].scheduleExpr)-1000),'real reminder clock delivery');
    report.reminder.modelCallsDuringDelivery=requests.length-baseline;
    check(requests.length===baseline,'S2 due reminder requires no model');
    await section('S2 reminder delivers existing benchmark snapshot',async()=>{
      const note=(await notes()).filter(n=>n.sourceId===job.id&&n.type==='reminder.due'&&n.createdAt>=Date.parse(after[0].scheduleExpr)-1000).sort((a,b)=>b.createdAt-a.createdAt)[0];
      const message=(await history()).messages.find(m=>m.requestId===note.dedupeKey);report.reminder.resultMessage=message;
      const file=message?.workFeedback?.report?.files?.find(f=>f.name==='benchmark.json');
      check(!!file?.openPath,'S2 reminder includes real benchmark file attachment');
      if(!file?.openPath)return;
      check(fs.existsSync(file.openPath)&&fs.readFileSync(file.openPath,'utf8')===fs.readFileSync(benchmark,'utf8'),'S2 reminder existing immutable snapshot matches current benchmark');
      const selector='[data-message-id="'+message.messageId+'"] button[aria-label="打开 benchmark.json"]';
      await until(()=>evaluate('!!document.querySelector('+JSON.stringify(selector)+')'),'reminder benchmark actual open button');
      report.reminder.openControl=await evaluate('(()=>{const b=document.querySelector('+JSON.stringify(selector)+');b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();b.click();return {label:b.getAttribute("aria-label"),visible:r.width>0&&r.height>0,clickedAt:Date.now()};})()');
      check(report.reminder.openControl.visible,'S2 reminder actual file open control visible and clicked');
    });
    if(eventBefore){const eventAfter=await detail(eventWork.workId);report.reminder.eventIndependence={before:eventBefore,after:eventAfter};check(eventAfter.intentRevision===eventBefore.intentRevision&&eventAfter.executions.length===eventBefore.executions.length&&(!eventRunBytes||fs.readFileSync(benchmarkRuns,'utf8')===eventRunBytes),'S2 independent reminder reschedule/delivery does not alter event Work or rerun benchmark');}
    check(JSON.stringify((await works()).map(w=>w.workId))===JSON.stringify(priorWorks),'S2 reminder creates no extra Work');
    await wait(4000);report.reminder.notifications=(await notes()).filter(n=>n.sourceId===job.id&&n.type==='reminder.due');
    // A prior 5-minute deadline may have passed during other cases: distinguish each schedule slot explicitly.
    check(report.reminder.notifications.filter(n=>n.createdAt>=Date.parse(after[0].scheduleExpr)-1000).length===1,'S2 rescheduled slot delivered once');
  });
  for(const probe of report.responsivenessProbes||[])await section('response sample '+probe.index,async()=>{await until(async()=>(await history()).messages.some(m=>m.role==='assistant'&&m.requestId===probe.user.requestId&&['completed','failed','cancelled','unknown'].includes(m.status)),'probe exact response '+probe.user.requestId);probe.answer=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===probe.user.requestId);});
  report.events=[...(report.eventsBeforeRestart||[]),...await evaluate('window.__scheduleEvents')];
  report.domObservationSamples=[...(report.domBeforeRestart||[]),...await evaluate('Object.values(window.__scheduleDomSamples)')].map(row=>({...row,hostEventToDomBodyMs:row.firstBodyLaidOutAt&&row.firstAnswerHostObservedAt?row.firstBodyLaidOutAt-row.firstAnswerHostObservedAt:null,hostEventToViewportBodyMs:row.firstBodyViewportAt&&row.firstAnswerHostObservedAt?row.firstBodyViewportAt-row.firstAnswerHostObservedAt:null,persistedMessageToViewportBodyMs:row.firstBodyViewportAt&&row.persistedCreatedAt?row.firstBodyViewportAt-row.persistedCreatedAt:null,persistedMessageToFileButtonMs:row.firstFileButtonViewportAt&&row.persistedCreatedAt?row.firstFileButtonViewportAt-row.persistedCreatedAt:null}));
  report.milestoneVisibility=report.domObservationSamples.filter(row=>row.workFeedback?.eventId?.startsWith('milestone:'));
  report.domMeasurementContract='requestAnimationFrame + actual laid-out text/control; viewport intersection recorded separately. Receipt/tool activity excluded. createdAt is persisted message timestamp, not database transaction commit instrumentation; missing observations remain null/untested.';
  report.history=await history();report.works=await works();report.modelCalls=requests.length;
  report.toolCalls=[...new Map(requests.flatMap(r=>r.messages||[]).flatMap(m=>m.tool_calls||[]).map(c=>[c.id,c])).values()];
  report.providerIntervals=rawUsageAudit;
  for(const probe of report.responsivenessProbes||[]){const events=report.events.filter(e=>e.role==='assistant'&&e.requestId===probe.user.requestId),prose=events.find(e=>e.segments?.some(s=>s.kind==='answer'&&s.text?.trim())||e.status==='completed'&&e.text?.trim()),done=events.find(e=>e.status==='completed');probe.timing={firstSubstantiveHostProseMs:prose?prose.at-probe.submittedAt:null,completedMs:done?done.at-probe.submittedAt:null};}
  const quantiles=key=>{const values=(report.responsivenessProbes||[]).map(p=>p.timing?.[key]).filter(Number.isFinite).sort((a,b)=>a-b);return {n:values.length,p50:values.length?values[Math.ceil(values.length*.5)-1]:null,p95:values.length?values[Math.ceil(values.length*.95)-1]:null,rawMs:values};};
  report.empiricalResponsiveness={firstSubstantive:quantiles('firstSubstantiveHostProseMs'),completion:quantiles('completedMs'),method:'nearest-rank empirical P50/P95, 8 small samples; host answer segment excluding receipt/planning commentary, not guaranteed visible DOM and not SLA',load:report.performanceCaveat};
  const diagnosticRows=JSON.parse(cp.execFileSync('python3',['-c',"import sqlite3,json,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(json.dumps([json.loads(r[0]) for r in c.execute('SELECT record_json FROM task_request_diagnostics')]))",path.join(home,'.mybuddy','app.db')],{encoding:'utf8',maxBuffer:32*1024*1024}));
  report.attributedRequests=diagnosticRows.map(d=>{let attribution={kind:'unknown',reason:'No exact foreground message, execution task, or binding identifier match'};const message=report.history.messages.find(m=>m.role==='assistant'&&d.executionScope==='bot-foreground:'+m.messageId);if(message)attribution={kind:'foreground',requestId:message.requestId,messageId:message.messageId};else for(const w of report.works){const binding=w.executions.find(e=>e.taskId===d.taskId);const review=w.executions.find(e=>String(d.executionScope).includes(e.bindingId));if(binding){attribution={kind:d.sourceKind==='subagent'?'work-subagent':'work-execution',workId:w.workId,bindingId:binding.bindingId};break;}if(review){attribution={kind:'work-result-review',workId:w.workId,bindingId:review.bindingId};break;}}return {id:d.id,model:d.model,taskId:d.taskId,executionScope:d.executionScope,sourceKind:d.sourceKind,status:d.status,startedAt:d.startedAt,finishedAt:d.finishedAt,usage:d.usage,knownCostUsd:d.knownCostUsd,costComplete:d.costComplete,attribution};});
  report.costAccounting={pricing:'Provider catalog pricing not measured; unknown costs are not zero',requests:report.attributedRequests.length,unknownAttribution:report.attributedRequests.filter(r=>r.attribution.kind==='unknown').length,completeCostRequests:report.attributedRequests.filter(r=>r.costComplete).length};

  for(const row of report.cases){const events=report.events.filter(e=>e.requestId===row.user.requestId&&e.role==='assistant');
    const prose=events.find(e=>e.segments?.some(s=>s.kind==='answer'&&typeof s.text==='string'&&s.text.trim())||(e.text?.trim()&&e.status==='completed'));
    row.timing={firstSubstantiveHostProseMs:prose?prose.at-row.submittedAt:null,foregroundFinalMs:events.find(e=>e.status==='completed')?events.find(e=>e.status==='completed').at-row.submittedAt:null,firstUsablePartialMs:row.id==='execution-B'&&report.parallelPartial?report.parallelPartial.at-row.submittedAt:row.id==='analysis-A'&&report.firstA?report.firstA.at-row.submittedAt:null,finalArtifactMs:row.id==='execution-B'&&report.finalAB?report.finalAB.at-row.submittedAt:null};
    row.measurement='Host persisted/observed prose, excluding receipt; not provider TTFT or native-input latency';
  }
  const identities=report.history.messages.filter(m=>m.workFeedback).map(m=>JSON.stringify([m.workFeedback.workId,m.workFeedback.executionId,m.workFeedback.eventId,m.workFeedback.category,m.workFeedback.report?.milestone?{summary:m.workFeedback.report.summary,files:m.workFeedback.report.files}:null]));
  report.duplicateFeedbackIdentities=identities.filter((x,i)=>identities.indexOf(x)!==i);check(!report.duplicateFeedbackIdentities.length,'no duplicate feedback identity');
  for(const width of [1280,390])await section('viewport '+width,async()=>{await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(200);check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'no horizontal overflow '+width);const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'scheduling-'+width+'.png'),Buffer.from(shot.data,'base64'));});
  // This lane does not fabricate a supported external event source. A separate hook lane must provide event/version ingress evidence.
  report.coverage.eventVersionDedup=report.fileEvent?.afterDuplicate?'real file receiver same-content/source-version dedup measured; external provider webhook untested':'not-established: file receiver scenario did not reach duplicate verification';
  clearInterval(artifactWatch);report.status=report.failures.length?'failed':'passed';persist();assert.equal(report.failures.length,0,report.failures.join('\n'));
};

/** Synthetic inputs only; these scripts measure/check, never repair renderer or query code. */
function seedActionFixtures(workspace) {
  const mixed=path.join(workspace,'mixed-history'),continuous=path.join(workspace,'continuous-render');
  fs.mkdirSync(mixed,{recursive:true});fs.mkdirSync(continuous,{recursive:true});
  const records=Array.from({length:12},(_,i)=>({id:i,title:i===1?'history-token-original':'record-'+i}));
  fs.writeFileSync(path.join(mixed,'records.json'),JSON.stringify(records));
  fs.writeFileSync(path.join(mixed,'search.cjs'),"exports.search=(records,query)=>records.slice(-3).filter(record=>record.title.includes(query));\n");
  fs.writeFileSync(path.join(mixed,'check.cjs'),`const fs=require('node:fs'),path=require('node:path');const records=JSON.parse(fs.readFileSync(path.join(__dirname,'records.json'),'utf8')),search=require('./search.cjs').search;const query='history-token-original',expected=records.filter(r=>r.title.includes(query)),actual=search(records,query);const result={recordCount:records.length,query,expectedIds:expected.map(r=>r.id),actualIds:actual.map(r=>r.id),passed:JSON.stringify(expected)===JSON.stringify(actual)};const name=process.argv[2]==='diagnose'?'diagnosis.json':'verification.json';fs.writeFileSync(path.join(__dirname,name),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(process.argv[2]!=='diagnose'&&!result.passed)process.exitCode=1;`);
  fs.writeFileSync(path.join(continuous,'records.json'),JSON.stringify(Array.from({length:8000},(_,i)=>({id:i,title:'Synthetic record '+i}))));
  fs.writeFileSync(path.join(continuous,'version.json'),JSON.stringify({version:'DATA-V1',ready:true,waitingFor:'DATA-V2'}));
  fs.writeFileSync(path.join(continuous,'renderer.js'),`window.renderRecords=records=>{const root=document.getElementById('root');root.replaceChildren();let html='';for(const id of records.map(r=>r.id)){const row=records.find(r=>r.id===id);html+='<div class="record" data-id="'+row.id+'">'+row.title+'</div>';}root.innerHTML=html;return root.childElementCount;};`);
  fs.writeFileSync(path.join(continuous,'measure-electron.cjs'),`const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setName('issue27-isolated-dom-measure');app.setPath('userData',path.join(__dirname,'.measurement-profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1024,height:768,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});await w.loadURL('data:text/html,<html><body><main id="root"></main></body></html>');const records=JSON.parse(fs.readFileSync(path.join(__dirname,'records.json'),'utf8'));await w.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'renderer.js'),'utf8')+';void 0');const rows=[];for(let i=0;i<3;i++){const result=await w.webContents.executeJavaScript('new Promise(resolve=>{const records='+JSON.stringify(records)+';const start=performance.now();const count=window.renderRecords(records);const built=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{const root=document.getElementById("root");resolve({inputCount:records.length,renderedCount:count,domBuildMs:built-start,nextFrameMs:performance.now()-start,accessible:root.getAttribute("role")==="list"&&[...root.children].every(e=>e.getAttribute("role")==="listitem")});}));})');rows.push(result);}console.log('ISSUE27_MEASUREMENT='+JSON.stringify(rows));w.destroy();app.quit();}).catch(e=>{console.error(e.stack);app.exit(1)});`);
  fs.writeFileSync(path.join(continuous,'measure.cjs'),`const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const label=process.argv[2];if(!['baseline','optimized','accessible','version2'].includes(label))throw Error('Use baseline, optimized, accessible, or version2');const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const output=cp.execFileSync(${JSON.stringify(require('electron'))},[path.join(__dirname,'measure-electron.cjs')],{env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});const line=output.split('\\n').find(l=>l.startsWith('ISSUE27_MEASUREMENT='));if(!line)throw Error('Missing real Electron measurements');const rows=JSON.parse(line.slice('ISSUE27_MEASUREMENT='.length));const version=JSON.parse(fs.readFileSync(path.join(__dirname,'version.json'),'utf8')).version;const file=path.join(__dirname,'measurements.csv');if(!fs.existsSync(file))fs.writeFileSync(file,'label,version,inputCount,renderedCount,domBuildMs,nextFrameMs,accessible\\n');for(const row of rows)fs.appendFileSync(file,[label,version,row.inputCount,row.renderedCount,row.domBuildMs,row.nextFrameMs,row.accessible].join(',')+'\\n');fs.writeFileSync(path.join(__dirname,label+'-result.json'),JSON.stringify({label,version,rows},null,2));console.log(JSON.stringify({label,version,rows}));if(rows.some(r=>r.inputCount!==r.renderedCount)||(label==='accessible'&&rows.some(r=>!r.accessible)))process.exitCode=1;`);
  return {mixed,continuous,mixedRecordsDigest:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(mixed,'records.json'))).digest('hex'),rendererOriginal:fs.readFileSync(path.join(continuous,'renderer.js'),'utf8'),measurementScriptDigest:require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(continuous,'measure.cjs'))).digest('hex')};
}
exports.seedActionFixtures=seedActionFixtures;

/** Bounded follow-up batch: seven distinct real request types; no long parallel or renderer lane. */
exports.runFocused=async({send,until,evaluate,history,rpc,report,requests,rawUsageAudit,out,home,modelKey,botId,restart})=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms)),crypto=require('node:crypto'),eventOnly=process.env.BOT_SCHEDULING_EVENT_ONLY==='1';
  const workspace=path.join(home,'focused-inputs');fs.mkdirSync(workspace,{recursive:true});
  const mixed=path.join(workspace,'mixed-history');fs.mkdirSync(mixed,{recursive:true});
  const records=JSON.stringify([{id:1,title:'history-token-original'},{id:2,title:'recent'}]);
  fs.writeFileSync(path.join(mixed,'records.json'),records);fs.writeFileSync(path.join(mixed,'search.cjs'),"exports.search=(rows,q)=>rows.slice(-1).filter(r=>r.title.includes(q));\n");
  fs.writeFileSync(path.join(mixed,'check.cjs'),`const fs=require('node:fs'),p=require('node:path'),rows=JSON.parse(fs.readFileSync(p.join(__dirname,'records.json'),'utf8'));const actual=require('./search.cjs').search(rows,'history-token-original').map(r=>r.id),result={actual,expected:[1],passed:JSON.stringify(actual)==='[1]'};fs.writeFileSync(p.join(__dirname,process.argv[2]==='diagnose'?'diagnosis.json':'verification.json'),JSON.stringify(result));console.log(JSON.stringify(result));`);
  fs.writeFileSync(path.join(workspace,'sales.csv'),'product,units,price\nTea,3,12\nCoffee,2,25\nCake,4,8\n');
  const prSource=path.join(workspace,'pr-merge.json'),benchmark=path.join(workspace,'benchmark.json'),runlog=path.join(workspace,'benchmark-runs.jsonl');
  const pr={pr:27,version:'PR-V1',merged:false,samples:[7,11,13],controlledDelayMs:0};fs.writeFileSync(prSource,JSON.stringify(pr)+'\n');
  fs.writeFileSync(path.join(workspace,'benchmark.cjs'),`const fs=require('node:fs'),p=require('node:path'),x=JSON.parse(fs.readFileSync(p.join(__dirname,'pr-merge.json'),'utf8'));if(!x.merged)throw Error('not merged');let sum=0;const samples=[];for(let n=0;n<3;n++){const t=process.hrtime.bigint();sum=0;for(let i=0;i<200000;i++)for(const v of x.samples)sum+=v;if(x.controlledDelayMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,x.controlledDelayMs);samples.push(Number(process.hrtime.bigint()-t)/1e6);}const elapsedMs=[...samples].sort((a,b)=>a-b)[1],bp=p.join(__dirname,'benchmark-baseline.json'),base=fs.existsSync(bp)?JSON.parse(fs.readFileSync(bp,'utf8')):null;const result={sourceVersion:x.version,checksum:sum,samples,elapsedMs,baselineMs:base?.elapsedMs??elapsedMs,regression:!!base&&elapsedMs>Math.max(3*base.elapsedMs,50),controlledDelayMs:x.controlledDelayMs,runAt:new Date().toISOString(),scope:'Synthetic local fixture, not user product performance'};if(!base)fs.writeFileSync(bp,JSON.stringify(result,null,2));fs.writeFileSync(p.join(__dirname,'benchmark.json'),JSON.stringify(result,null,2));fs.appendFileSync(p.join(__dirname,'benchmark-runs.jsonl'),JSON.stringify(result)+'\\n');console.log(JSON.stringify(result));`);
  const works=()=>evaluate('window.api.botWork.listWorks(true)'),detail=id=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`),jobs=()=>evaluate('window.api.cron.list()'),notes=()=>evaluate('window.api.notification.list({limit:100})');
  const queryDb=(sql,args=[])=>JSON.parse(cp.execFileSync('python3',['-c',"import sqlite3,json,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute(sys.argv[2],json.loads(sys.argv[3]))]))",path.join(home,'.mybuddy','app.db'),sql,JSON.stringify(args)],{encoding:'utf8',maxBuffer:16*1024*1024}));
  const proof=id=>queryDb('SELECT b.binding_id,b.admitted_at,b.input_snapshot_id,b.status,r.state,r.attempts,r.context_json,r.decision_json,r.error FROM work_execution_bindings b LEFT JOIN work_watch_reviews r ON r.binding_id=b.binding_id WHERE b.work_id=? ORDER BY b.admitted_at',[id]).map(x=>({...x,context:x.context_json?JSON.parse(x.context_json):null,decision:x.decision_json?JSON.parse(x.decision_json):null,notifications:queryDb("SELECT message_id,metadata_json FROM bot_work_feedback WHERE json_extract(metadata_json,'$.executionId')=? AND json_extract(metadata_json,'$.kind')='result'",[x.binding_id])}));
  report.batchMode=eventOnly?'focused-six-types-event-chain':'focused-seven-types-plus-revision-gate';report.cases=[];report.evidence=[];report.failures=[];report.workspace=workspace;report.coverage={real:'Electron, real Flash, tools, clock, fs.watch, persisted Work and immutable files',simulated:'Local PR JSON and controlled benchmark delay; not GitHub webhook',excluded:'Long A/B sleep, miniDOM optimization, weather, and service fault injection not repeated'};
  const persist=()=>{report.modelCalls=requests.length;report.actualModels=[...new Set(requests.map(q=>q.model))];report.checkpointAt=Date.now();fs.writeFileSync(path.join(out,'scheduling-progress.json'),JSON.stringify(report,null,2));};
  const check=(ok,label,data)=>{report.evidence.push({label,passed:!!ok,data});if(!ok)report.failures.push(label);persist();};
  const section=async(name,fn)=>{try{await fn();}catch(e){report.failures.push(name+': '+e.message);report.evidence.push({label:name,passed:false,error:e.stack});persist();}};
  const complete=async row=>{await until(async()=>{row.answer=(await evaluate(`window.api.botWork.history(${JSON.stringify({botId,conversationId:row.user.conversationId})})`)).messages.find(m=>m.role==='assistant'&&m.requestId===row.user.requestId&&['completed','failed','cancelled','unknown'].includes(m.status));return !!row.answer;},'exact request '+row.user.requestId);row.completedObservedAt=Date.now();persist();return row;};
  const request=async prompt=>{const row={prompt,submittedAt:Date.now()};await send(prompt);row.user=(await history()).messages.filter(m=>m.role==='user').at(-1);assert(row.user?.requestId);return complete(row);};
  const owner=(await evaluate('window.api.botWork.listBots()')).find(b=>b.botId===botId);assert((await evaluate(`window.api.botWork.updateWorkspaceAuthorization(${JSON.stringify({botId,expectedUpdatedAt:owner.updatedAt,allowWorkspaceFiles:true,confirmNewWorksOnly:true})})`)).ok);
  const settings=(await evaluate(`window.api.botWork.getSettings(${JSON.stringify(botId)})`)).settings;assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
  const install=()=>evaluate(`(()=>{window.__focusedUnsubscribe?.();window.__focusedEvents=[];window.__focusedUnsubscribe=window.api.botWork.onMessageChanged(e=>window.__focusedEvents.push({at:Date.now(),message:e.message}));return true;})()`);await install();
  const gate=path.join(workspace,'revision-gate.txt'),gateA=path.join(workspace,'gate-a.txt'),gateB=path.join(workspace,'gate-b.txt');
  const agents=path.join(home,'.mybuddy','agents');fs.mkdirSync(agents,{recursive:true});fs.writeFileSync(path.join(agents,'reader.md'),'---\nname: reader\ndescription: Execute isolated acceptance tasks using real tools.\n---\nFollow current assignment and latest revision exactly. Read and register actual files; never fabricate receipts.\n');
  const cases=[
    {id:'revision-gate',type:'execution-amendment',prompt:`建立一次性后台委托“短验改向”：用现有用户目录reader角色（agentScope=user），一次subagent tasks并行两个子任务，isolation=shared、cwd=${workspace}。A尽快真实write ${gateA} 内容A-READY，read回读并登记文件，先交付该可用成果。B先真实write ${gateB} 内容B-ORIGINAL，随后用真实bash等待 ${gate} 出现，最长180秒；这是测试脚本控制的模拟外部依赖，不是固定sleep。gate出现后read B文件回读登记，最终交付。不要联网，不要替换为串行执行，不自行写gate。已完成的A不要因后续对B的调整重做。`},
    {id:'direct',type:'direct-answer',prompt:'只直接回答137*29的结果，不调用工具，不创建Work。'},
    {id:'query',type:'current-state-query',prompt:'当前有哪些Work正在执行或等待？只查询真实当前状态，一句话回答，不创建或修改任何任务。'},
    {id:'analysis',type:'analysis',prompt:'建立一次性后台委托“短验分析”：真实read工作区sales.csv，计算总销售额和收入最高产品，写analysis.csv并回读登记交付；不改原始sales.csv。'},
    {id:'execution',type:'file-execution',prompt:'建立一次性后台委托“短验执行”：真实读取sales.csv，把其字节完整写到copy.csv，再回读核对并登记交付；不修改任何原文件。'},
    {id:'reminder',type:'reminder',prompt:'5分钟后提醒我“检查短验结果”，名称“短验独立提醒”。只发提醒，不执行任务，不创建Work。'},
    {id:'file-event',type:'event-driven-benchmark',prompt:`建立持续事件委托“短验PRbenchmark”：${prSource} 是明确模拟的本地PR状态文件，不是真实GitHub。用已接入file事件源、这个绝对eventTarget、next_event、continuous、latest、changes_only、notifyInitial=true；不设cron，创建时不执行。真实变化后先读取来源，merged=true时只实际运行一次工作区 node benchmark.cjs，回读登记指定成品 benchmark.json。首个合并事件交付实际基线；后续新版本仍实际运行并登记，但只有 regression=true 才通知我，regression=false 时静默，不发普通结果通知。脚本实测三次中位数，阈值max(基线三倍,50ms)；controlledDelayMs是明确标注的本地受控负载非真实产品性能。相同字节/版本重复事件不重跑。不要改脚本，不伪造数据，不联网；处理后继续等待真实变化。`},
    {id:'mixed',type:'mixed-direct-execution-reminder',prompt:`同一请求三件事：立即直接答23+19；建立一次性后台委托“短验混合检索”，其执行范围仅为${mixed}：先read并运行node check.cjs diagnose，判断能修就修search.cjs让history-token-original可查，运行node check.cjs verify，回读登记诊断/验证成品，不改records.json或check.cjs；另外独立设置2分钟后提醒“查看短验混合结果”，名称“短验混合提醒”。这三个分支都属于本次请求，提醒不替代修复。`}
  ];
  if(eventOnly)cases.splice(0,cases.length,...cases.filter(c=>!['revision-gate','mixed'].includes(c.id)));
  // Every real inference batch submits >=6 distinct semantic task types before collecting any result.
  cases.sort((a,b)=>a.id==='direct'?-1:b.id==='direct'?1:0);
  for(const c of cases){c.submittedAt=Date.now();report.cases.push(c);await send(c.prompt);c.user=(await history()).messages.filter(m=>m.role==='user').at(-1);assert(c.user?.requestId);persist();
    if(c.id==='direct')await section('official new conversation without extra inference',async()=>{await complete(c);const beforeCalls=requests.length;report.crossConversation={originalConversationId:c.user.conversationId,originalRequestId:c.user.requestId,method:'Official new-conversation UI; remaining planned cases create second persisted conversation, no extra model request',multiProductWindow:'unsupported: product single main-window lifecycle; not claimed tested'};await evaluate('document.querySelector(".bot-new-conversation").click()');await until(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'),'official new conversation confirmation');await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');await until(async()=>(await history()).messages.length===0&&!await evaluate('!!document.querySelector("dialog[open]")'),'new empty conversation UI');check(requests.length===beforeCalls,'new conversation UI itself invokes no model');});
  }
  if(report.crossConversation){report.crossConversation.secondConversationId=cases.find(c=>c.id==='query').user.conversationId;check(report.crossConversation.secondConversationId!==report.crossConversation.originalConversationId,'planned cases establish two real conversation identities');}

  check(new Set(cases.map(c=>c.type)).size>=6,'at least six distinct types submitted in this same batch');
  if(!eventOnly)await section('controlled revision gate',async()=>{
    let w;await until(async()=>{w=(await works()).find(x=>x.title==='短验改向');return !!w;},'gate Work created');
    let partial;await until(async()=>{partial=(await history()).messages.find(m=>m.workIds?.includes(w.workId)&&m.workFeedback?.report?.milestone&&m.workFeedback.report.files?.some(f=>f.name==='gate-a.txt'));return !!partial&&fs.existsSync(gateB);},'A actual milestone and B prior write');
    const before=await detail(w.workId),aBytes=fs.readFileSync(gateA),aDigest=crypto.createHash('sha256').update(aBytes).digest('hex');report.revisionGate={initialWork:before,partialMessage:partial,initialADigest:aDigest,gateIsSimulatedExternalCondition:true};
    check(before.executions.some(e=>e.status==='running'),'A delivered while actual B execution remains busy');
    report.revisionGate.amendment=await request('修改“短验改向”：只把B最终内容改为B-AMENDED；已经完成交付的gate-a.txt必须保持原字节，不得再write。B已经写好的旧值也不要重写，先核实并复用现有状态，再等待原测试gate出现，之后写新值并回读登记。不要创建新Work，不要重演旧任务流程。');
    await until(async()=>{const current=await detail(w.workId);report.revisionGate.amendedWork=current;return current.intentRevision>before.intentRevision&&current.executions.some(e=>e.intentRevision===current.intentRevision&&['running','admitted','pending'].includes(e.status));},'r2 actual execution admitted');
    report.revisionGate.gateReleasedAt=Date.now();fs.writeFileSync(gate,'RELEASE\n');
    let final;await until(async()=>{final=await detail(w.workId);return final.lifecycle==='closed';},'revised gate Work closes');report.revisionGate.finalWork=final;
    check(final.closureConclusion==='succeeded','revised gate goal closes succeeded');check(fs.readFileSync(gateA).equals(aBytes),'completed A actual bytes/digest unchanged');check(fs.readFileSync(gateB,'utf8').trim()==='B-AMENDED','revised B actual final content');
    const stores=[...new Set(final.executions.map(e=>e.durableStoreKey).filter(Boolean))],receipts=[];for(const store of stores){const p=path.join(store,'main.jsonl');if(!fs.existsSync(p))continue;for(const line of fs.readFileSync(p,'utf8').split('\n').filter(Boolean)){let row;try{row=JSON.parse(line);}catch{continue;}receipts.push({store,row});}}
    report.revisionGate.durableReceiptFiles=stores.map(s=>path.join(s,'main.jsonl'));report.revisionGate.durableRowsContainingTargets=receipts.filter(x=>JSON.stringify(x.row).includes('gate-a.txt')||JSON.stringify(x.row).includes('gate-b.txt')).map(x=>({store:x.store,seq:x.row.seq,sha256:crypto.createHash('sha256').update(JSON.stringify(x.row)).digest('hex')}));
    report.revisionGate.nativeWriteReceipts=receipts.flatMap(x=>(x.row.writes||[]).filter(w=>w.type==='entry').flatMap(w=>(w.value?.model||[]).filter(m=>m.role==='toolResult'&&m.toolName==='write'&&JSON.stringify(m.content).match(/gate-[ab]\.txt/)).map(m=>({store:x.store,seq:x.row.seq,entryId:w.value.id,conversationId:w.value.conversationId,...m}))));
    const calls=[...new Map(requests.flatMap(q=>q.messages||[]).flatMap(m=>m.tool_calls||[]).map(t=>[t.id,t])).values()].filter(t=>t.function?.name==='write').map(t=>{try{return{id:t.id,...JSON.parse(t.function.arguments)};}catch{return null;}}).filter(Boolean);
    report.revisionGate.distinctWriteCalls=calls.filter(c=>[gateA,gateB].includes(c.path));
    const successfulIds=new Set(report.revisionGate.nativeWriteReceipts.filter(r=>!r.isError).map(r=>r.toolCallId));check(calls.filter(c=>c.path===gateA&&successfulIds.has(c.id)).length===1,'A actual native write receipt occurs exactly once');
    check(calls.filter(c=>c.path===gateA).length===1,'A write occurs exactly once across original and revised execution');check(calls.filter(c=>c.path===gateB&&c.content?.trim()==='B-ORIGINAL'&&successfulIds.has(c.id)).length===1,'B old-value write occurs exactly once');check(calls.filter(c=>c.path===gateB&&c.content?.trim()==='B-AMENDED'&&successfulIds.has(c.id)).length===1,'B new-value write occurs exactly once');
    report.revisionGate.replayAssessment='Distinct actual native write call identities plus disk digest checked; durable raw rows retained for current revision/handoff and unknown-action audit. Unknown is not assumed successful.';
    const childContexts=[];for(const q of requests){for(const m of q.messages||[]){const text=typeof m.content==='string'?m.content:'';let pos=text.indexOf('workRevisionContext=');if(pos<0)continue;const tail=text.slice(pos+'workRevisionContext='.length),start=tail.indexOf('{');if(start<0)continue;let depth=0,quoted=false,escaped=false;for(let i=start;i<tail.length;i++){const ch=tail[i];if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}else if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0){try{const context=JSON.parse(tail.slice(start,i+1));if(context.source?.workId===w.workId&&context.source?.intentRevision===final.intentRevision)childContexts.push(context);}catch{}break;}}}}
    report.revisionGate.currentChildRevisionContexts=[...new Map(childContexts.map(c=>[JSON.stringify(c.source),c])).values()];
    report.revisionGate.childContextAssessment=childContexts.length?'Observed actual model system workRevisionContext for this Work/latest intent; raw source/handoff preserved':'No matching child context observed; requires durable audit to distinguish no redelegation from missing inheritance, not claimed passed';

  });

  for(const c of cases)await section('foreground '+c.id,()=>complete(c));
  check(cases[0].answer?.text.includes('3973'),'direct arithmetic answer');
  for(const [id,title,name] of [['analysis','短验分析','analysis.csv'],['execution','短验执行','copy.csv'],['mixed','短验混合检索','verification.json']].filter(([id])=>cases.some(c=>c.id===id)))await section('verified closure '+id,async()=>{
    const origin=cases.find(c=>c.id===id),linked=queryDb('SELECT work_id FROM works WHERE source_message_id=?',[origin.user.messageId]);assert.equal(linked.length,1,title+' unique Work from exact original request');const work=(await works()).find(w=>w.workId===linked[0].work_id);assert(work,title+' exists');let w;await until(async()=>{w=await detail(work.workId);return w.lifecycle==='closed';},title+' closed');(report.simpleWorks ||= {})[id]=w;check(w.closureConclusion==='succeeded',title+' closes succeeded within its own delegated scope');
    const msgs=(await history()).messages.filter(m=>m.workIds?.includes(w.workId));const delivered=msgs.flatMap(m=>m.workFeedback?.report?.files||[]),file=delivered.find(f=>f.name===name);
    if(id==='mixed'){
      const proof=(w.generatedArtifacts||[]).filter(a=>a.snapshotPath&&fs.existsSync(a.snapshotPath)&&crypto.createHash('sha256').update(fs.readFileSync(a.snapshotPath)).digest('hex')===a.digest&&delivered.some(f=>f.openPath===a.snapshotPath)).map(a=>({path:a.path,snapshotPath:a.snapshotPath,text:fs.readFileSync(a.snapshotPath,'utf8')}));
      const objects=proof.flatMap(a=>{const candidates=[a.text,...a.text.split('\n')];return candidates.flatMap(text=>{try{return [{...a,value:JSON.parse(text)}];}catch{return [];}});});(report.mixedRegisteredProof ||= []).push(...proof);
      check(objects.some(a=>a.value.passed===false&&JSON.stringify(a.value.expected)==='[1]'&&JSON.stringify(a.value.actual)==='[]')&&objects.some(a=>a.value.passed===true&&JSON.stringify(a.value.expected)==='[1]'&&JSON.stringify(a.value.actual)==='[1]'),title+' actual registered diagnosis and successful verification contents');
    }else check(!!file?.openPath&&fs.existsSync(file.openPath)&&(w.generatedArtifacts||[]).some(a=>a.snapshotPath===file.openPath&&crypto.createHash('sha256').update(fs.readFileSync(file.openPath)).digest('hex')===a.digest),title+' actual registered immutable file');
    if(id==='execution')check(fs.readFileSync(path.join(workspace,'copy.csv'),'utf8')===fs.readFileSync(path.join(workspace,'sales.csv'),'utf8'),'execution copied actual source bytes');
    if(id==='mixed'){check(fs.readFileSync(path.join(mixed,'records.json'),'utf8')===records&&JSON.parse(fs.readFileSync(path.join(mixed,'verification.json'),'utf8')).passed,'mixed preserves original records and truly repairs query');const ops=queryDb('SELECT operation_id,result_json FROM cron_reminder_operations WHERE operation_id LIKE ?',['%:'+cases.find(c=>c.id==='mixed').user.requestId+':%']);report.mixedReminderOperations=ops;check(ops.some(o=>o.result_json.includes('短验混合提醒')),'mixed reminder creation linked to exact original request');}
  });
  let eventWork;
  await section('file-event three real versions',async()=>{
    eventWork=(await works()).find(w=>w.title==='短验PRbenchmark');assert(eventWork);let baseline;
    await until(async()=>{baseline=await detail(eventWork.workId);return baseline.phase4.subscriptions.some(s=>s.source==='file'&&s.status==='online'&&s.cursors?.some(c=>c.enumerationWatermark));},'real file receiver baseline');report.event={baseline,versions:[]};
    check(baseline.executions.length===0&&!fs.existsSync(benchmark),'next_event does not execute at baseline');check(baseline.phase4.subscriptions.every(s=>!s.cronExpression),'event source has no cron substitute');
    for(const [version,delay,wantSilent] of [['PR-V2',0,false],['PR-V3',0,true],['PR-V4',100,false]])await section('event '+version,async()=>{
      const text=JSON.stringify({...pr,version,merged:true,controlledDelayMs:delay})+'\n',hash='sha256:'+crypto.createHash('sha256').update(text).digest('hex'),at=Date.now();fs.writeFileSync(prSource,text);
      let p;await until(()=>{p=proof(eventWork.workId).findLast(x=>x.input_snapshot_id===hash&&x.admitted_at>=at);return p?.status==='completed'&&['silent','delivered','superseded'].includes(p.state);},version+' native execution and reviewed result');
      const result=JSON.parse(fs.readFileSync(benchmark,'utf8'));const inbox=queryDb("SELECT event_id,source_version,payload_json,status FROM work_events_inbox WHERE work_id=? AND source='file' AND source_version=?",[eventWork.workId,hash]);report.event.versions.push({version,mutationAt:at,hash,proof:p,result,inbox});
      check(inbox.some(e=>JSON.parse(e.payload_json).observation==='fs-watch'&&e.status==='processed'),version+' real fs.watch ingress matches binding source version');
      check(result.sourceVersion===version&&result.checksum===6200000&&result.regression===(version==='PR-V4'),version+' actual measured result and baseline comparison');
      check(wantSilent?p.state==='silent'&&p.notifications.length===0:p.state==='delivered'&&p.notifications.length>0,version+' expected business-condition notification visibility');
      const current=(p.context?.artifactEvidence||[]).find(f=>f.name==='benchmark.json'&&f.state==='text');check(!!current&&JSON.parse(current.text).sourceVersion===version,version+' current benchmark registered bytes in host evidence');
      if(version==='PR-V2')await section('same-version dedup',async()=>{const before=(await detail(eventWork.workId)).executions.length,bytes=fs.readFileSync(runlog,'utf8'),events=queryDb("SELECT event_id FROM work_events_inbox WHERE work_id=? AND source='file'",[eventWork.workId]).length;fs.writeFileSync(prSource,text);await wait(1000);fs.writeFileSync(prSource,text);await wait(5000);check((await detail(eventWork.workId)).executions.length===before&&fs.readFileSync(runlog,'utf8')===bytes&&queryDb("SELECT event_id FROM work_events_inbox WHERE work_id=? AND source='file'",[eventWork.workId]).length===events,'identical bytes produce no extra inbox, execution, or benchmark');});
    });
  });
  await section('existing-result reminder',async()=>{
    const job=(await jobs()).find(j=>j.name==='短验独立提醒');assert(job);const beforeWorks=(await works()).map(w=>w.workId),before=eventWork?await detail(eventWork.workId):null,runBytes=fs.existsSync(runlog)?fs.readFileSync(runlog,'utf8'):null;
    report.reminderRequest=await request(`把短验独立提醒 ${job.id} 改为20秒后，保持同一提醒，同时关联“短验PRbenchmark”当前已登记benchmark.json，到期以真实可打开文件交付已有成果。不要重跑benchmark，不新建Work，不改事件Work，不用纯文本路径冒充附件。`);
    const updated=(await jobs()).filter(j=>j.name==='短验独立提醒');check(updated.length===1&&updated[0].id===job.id,'reminder reschedule retains identity');const due=Date.parse(updated[0].scheduleExpr),startCalls=requests.length;let note;
    await until(async()=>{note=(await notes()).find(n=>n.sourceId===job.id&&n.type==='reminder.due'&&n.createdAt>=due-1000);return !!note;},'real reminder clock');report.reminder={id:job.id,due,modelCallsDuringDue:requests.length-startCalls};check(requests.length===startCalls,'reminder due invokes zero models');
    const message=(await history()).messages.find(m=>m.requestId===note.dedupeKey),file=message?.workFeedback?.report?.files?.find(f=>f.name==='benchmark.json');report.reminder.message=message;const oldHistory=await evaluate(`window.api.botWork.history(${JSON.stringify({botId,conversationId:report.crossConversation.originalConversationId})})`);check(!oldHistory.messages.some(m=>m.requestId===note.dedupeKey)&&message?.conversationId===cases.find(c=>c.id==='reminder').user.conversationId,'reminder delivered only to its original second conversation, not archived direct conversation');check(!!file?.openPath&&fs.existsSync(file.openPath)&&fs.readFileSync(file.openPath,'utf8')===fs.readFileSync(benchmark,'utf8'),'reminder delivers exact existing immutable benchmark snapshot');
    if(file){const selector='[data-message-id="'+message.messageId+'"] button[aria-label="打开 benchmark.json"]';await until(()=>evaluate('!!document.querySelector('+JSON.stringify(selector)+')'),'actual reminder open control');report.reminder.open=await evaluate('(()=>{const b=document.querySelector('+JSON.stringify(selector)+');b.scrollIntoView({block:"center"});const r=b.getBoundingClientRect();b.click();return {visible:r.width>0&&r.height>0,at:Date.now()};})()');check(report.reminder.open.visible,'reminder actual snapshot open button clicked');}
    check(JSON.stringify((await works()).map(w=>w.workId))===JSON.stringify(beforeWorks),'reminder creates zero additional Work');if(before){const after=await detail(eventWork.workId);check(after.intentRevision===before.intentRevision&&after.executions.length===before.executions.length&&fs.readFileSync(runlog,'utf8')===runBytes,'reminder does not change event Work or rerun benchmark');}
    await wait(3000);check((await notes()).filter(n=>n.sourceId===job.id&&n.type==='reminder.due'&&n.createdAt>=due-1000).length===1,'same reminder slot delivered once');
  });
  await section('independent restart',async()=>{const id=(await history()).conversationId;report.eventsBeforeRestart=await evaluate('window.__focusedEvents');await restart();await install();check((await history()).conversationId===id,'restart preserves original conversation');if(eventWork){const w=await detail(eventWork.workId);report.afterRestartEvent=w;check(w.lifecycle==='active'&&w.phase4.subscriptions.some(s=>s.source==='file'&&s.status==='online'),'restart preserves live file subscription');}});
  for(const width of [1280,390])await section('viewport '+width,async()=>{await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(200);check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'no horizontal overflow '+width);const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'focused-'+width+'.png'),Buffer.from(shot.data,'base64'));});
  if(!eventOnly)await section('official original-conversation navigation roundtrip',async()=>{
    assert(report.crossConversation?.secondConversationId);const beforeCalls=requests.length;await rpc('Emulation.clearDeviceMetricsOverride');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="普通模式").click()');
    const nav=await evaluate('window.api.botWork.workspaceNavigation()');report.crossConversation.navigation=nav;const original=cases.find(c=>c.id==='direct'),second=cases.find(c=>c.id==='query'),space=nav.spaces.find(s=>s.id===nav.foregroundRequests.find(q=>q.requestId===original.user.requestId)?.spaceId);assert(space);
    const hasSpace=()=>evaluate('[...document.querySelectorAll(".space-header")].some(e=>e.querySelector(".space-name")?.textContent==='+JSON.stringify(space.name)+')');
    if(!await hasSpace()){await until(()=>evaluate('[...document.querySelectorAll(".space-header")].some(e=>e.querySelector(".space-name")?.textContent==="Bot")'),'Bot workspace group');await evaluate('[...document.querySelectorAll(".space-header")].find(e=>e.querySelector(".space-name")?.textContent==="Bot").querySelector(".space-chevron").click()');}
    await until(hasSpace,'original Bot workspace');await evaluate('[...document.querySelectorAll(".space-header")].find(e=>e.querySelector(".space-name")?.textContent==='+JSON.stringify(space.name)+').click()');
    report.crossConversation.visits=[];
    for(const c of [original,second,original]){const group='.workspace-conversation-group[data-conversation-id="'+c.user.conversationId+'"]',navRequest=nav.foregroundRequests.find(q=>q.requestId===c.user.requestId);await until(()=>evaluate('!!document.querySelector('+JSON.stringify(group)+')'),'original conversation group');await evaluate('(()=>{const d=document.querySelector('+JSON.stringify(group)+');if(!d.open)d.querySelector("summary").click();const b=[...d.querySelectorAll("button.workspace-overview-task-row")].find(b=>b.textContent.includes('+JSON.stringify(navRequest.title)+'));if(!b)throw Error("Request row missing");b.click();})()');await until(()=>evaluate('document.querySelector(".workspace-origin-conversation")?.title==='+JSON.stringify(c.user.conversationId)),'exact source conversation heading');const view=await evaluate(`(()=>{const e=document.querySelector('[aria-label="前台任务对话"]');return {conversationId:document.querySelector(".workspace-origin-conversation")?.title,messageIds:[...e.querySelectorAll("[data-message-id]")].map(x=>x.dataset.messageId),text:e.innerText};})()`);report.crossConversation.visits.push(view);check(view.messageIds.includes(c.user.messageId)&&view.messageIds.includes(c.answer.messageId),'exact original request and answer shown '+c.id);await evaluate('document.querySelector(".workspace-foreground-heading button").click()');}
    check(requests.length===beforeCalls,'conversation navigation roundtrip invokes zero extra models');
  });
  report.events=[...(report.eventsBeforeRestart||[]),...await evaluate('window.__focusedEvents')];report.history=await history();report.histories=await Promise.all([...new Set(cases.map(c=>c.user.conversationId))].map(conversationId=>evaluate(`window.api.botWork.history(${JSON.stringify({botId,conversationId})})`)));report.works=await works();report.requestDiagnostics=queryDb('SELECT record_json FROM task_request_diagnostics').map(x=>JSON.parse(x.record_json));report.providerIntervals=rawUsageAudit;
  report.toolCalls=[...new Map(requests.flatMap(q=>q.messages||[]).flatMap(m=>m.tool_calls||[]).map(t=>[t.id,t])).values()];report.pricing='Not measured; unknown is not zero';report.status=report.failures.length?'failed':'passed';persist();assert.equal(report.failures.length,0,report.failures.join('\n'));
};
