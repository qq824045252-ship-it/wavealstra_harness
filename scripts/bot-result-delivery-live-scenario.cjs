const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,home,out,modelKey,botId})=>{
const workspace=path.join(home,'delivery-inputs');fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace,'sales.csv'),'product,units,price\nTea,3,12\nCoffee,2,25\nCake,4,8\n');
fs.writeFileSync(path.join(workspace,'average.js'),'export function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }\n');
const owner=(await evaluate('window.api.botWork.listBots()')).find(b=>b.botId===botId);
assert((await evaluate(`window.api.botWork.updateWorkspaceAuthorization(${JSON.stringify({botId,expectedUpdatedAt:owner.updatedAt,allowWorkspaceFiles:true,confirmNewWorksOnly:true})})`)).ok);
const settings=(await evaluate(`window.api.botWork.getSettings(${JSON.stringify(botId)})`)).settings;
assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
const member=await evaluate(`window.api.botWork.createBot(${JSON.stringify({requestId:crypto.randomUUID(),displayName:'徒步文件制作员',responsibilitySummary:'真实创建并修订用户要求的文件，核对最新内容'})})`);assert(member.ok);
const responsibility='只在当前工作区操作：先用 write 创建 packing.md，包含 WATER-1L 和五件通用徒步用品；然后再用 write 或 edit 把 WATER-1L 修订为 WATER-2L，实际回读确认不再包含 WATER-1L。另创建 schedule.csv，内容为 time,event\n09:00,集合\n09:30,出发\n12:00,午餐\n14:00,返回。回读两份最终文件。不要使用脚本、联网、发布或创建额外文件。汇报当前两个文件绝对路径。';
assert((await evaluate(`window.api.botWork.teamControl(${JSON.stringify({kind:'save_template',request:{operationId:'delivery-team-template',name:'徒步双文件交付',plan:{workspacePath:workspace,ownerBotId:botId,ownerResponsibility:'只读汇总成员完成情况，用两句话向用户介绍两个最终文件，不得自己写文件，不要再生成报告。',executionPolicy:'parallel',maxConcurrency:1,members:[{botId:member.bot.botId,responsibility,delegatedScope:['workspace:read','workspace:write']}]}}})})`)).ok);
const cases=[
['html-talk',true,['talk.html'],'建立一次性后台委托“科学小讲堂”：制作可离线打开的 talk.html，给小学生讲解水循环，包含蒸发、凝结、降水和各一条讲稿提示，约两分钟。真实写入并回读，不发布不联网。交付HTML文件和一句说明。'],
['csv-analysis',true,['sales-summary.csv'],'建立独立一次性后台委托“销售复算”：真实读取工作区 sales.csv，按 product 计算 revenue，写 sales-summary.csv，包含总计行，并回读结果。用一句话告诉我总收入和收入最高产品，附结果文件。'],
['text-explanation',false,[],'直接用不超过120字解释为什么冬天窗户内侧会出现水珠，包含一个容易理解的例子。纯文字，不创建文件、不创建后台任务。'],
['multiple-deliverables',true,['packing.md','schedule.csv'],'请使用已保存的“徒步双文件交付”团队，现在开始真实制作并修订两份文件，严格按模板完成，负责人只读总结不写文件。成员必须先写 WATER-1L 再修订为 WATER-2L 并回读。交付最新的 packing.md 与 schedule.csv 两份成果文件，简短说明。不要创建普通独立 Work，不联网、不发布。'],
['missing-facts',false,[],'请告诉我我的护照确切到期日，以及我下个月去日本是否需要续办。我的护照和出行日期还没提供，也没有可读取的相关资料。不要猜，不创建文件或后台任务，只告诉我你还需要哪些信息。'],
['code-review',true,[],'建立独立一次性后台委托“均值函数审查”：真实读取工作区 average.js，审查空数组输入有什么问题，给出具体原因和建议修复代码。只读审查，不修改文件、不创建报告文件，交付简洁文字结论。']
];report.cases=[];report.workspace=workspace;
const persist=()=>fs.writeFileSync(path.join(out,'cases-progress.json'),JSON.stringify(report,null,2));
for(const [id,isWork,files,prompt]of cases){const row={id,prompt,status:'running'};report.cases.push(row);persist();try{
const before=(await history()).messages.map(m=>m.messageId),known=(await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId),offset=requests.length;
await send(prompt);await foregroundDone();
if(isWork){await until(async()=>(await evaluate('window.api.botWork.listWorks(true)')).some(w=>!known.includes(w.workId)),id+' Work');
const workId=(await evaluate('window.api.botWork.listWorks(true)')).find(w=>!known.includes(w.workId)).workId;
await until(async()=>(await history()).messages.some(m=>!before.includes(m.messageId)&&m.workFeedback?.report?.completion&&['deliver','ask'].includes(m.workFeedback.report.completion.nextStep)&&['result','decision'].includes(m.workFeedback.category)&&m.workIds.includes(workId)),id+' delivery');
row.work=await evaluate(`window.api.botWork.getWork(${JSON.stringify(workId)})`);}
row.messages=(await history()).messages.filter(m=>!before.includes(m.messageId));row.modelCalls=requests.length-offset;assert(row.modelCalls>0);
const message=isWork?row.messages.findLast(m=>m.workFeedback?.report?.completion&&['deliver','ask'].includes(m.workFeedback.report.completion.nextStep)&&['result','decision'].includes(m.workFeedback.category)):row.messages.findLast(m=>m.role==='assistant'&&m.status==='completed');assert(message);row.resultMessage=message;
const selector=`[data-message-id="${message.messageId}"]`;
await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),'visible result');
await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);await new Promise(r=>setTimeout(r,400));
row.presentation=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return {text:el.innerText,body:el.querySelector('.bot-result-body')?.innerText,buttons:[...el.querySelectorAll('button')].map(b=>({text:b.innerText,disabled:b.disabled})),details:[...el.querySelectorAll('details')].map(d=>({label:d.querySelector('summary')?.innerText,open:d.open})),files:[...el.querySelectorAll('.bot-result-files strong')].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.innerText),overflow:document.documentElement.scrollWidth>innerWidth+1}})()`);
const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});row.screenshot=path.join(out,id+'.png');fs.writeFileSync(row.screenshot,Buffer.from(shot.data,'base64'));
row.artifacts=(row.work?.generatedArtifacts||[]).map(a=>({...a,exists:fs.existsSync(a.snapshotPath||a.path),actualDigest:fs.existsSync(a.snapshotPath||a.path)?crypto.createHash('sha256').update(fs.readFileSync(a.snapshotPath||a.path)).digest('hex'):null}));
row.deliveredFiles=message.workFeedback?.report?.files||[];row.primaryRefs=message.workFeedback?.report?.primaryArtifactRefs;row.deliveredArtifacts=row.deliveredFiles.map(f=>({...f,artifact:row.artifacts.find(a=>a.snapshotPath===f.openPath)}));
row.failures=[];const check=(ok,label)=>{if(!ok)row.failures.push(label)};
row.reviewInputs=requests.slice(offset).flatMap(r=>r.messages||[]).filter(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('{"temporalContext"')).map(m=>{try{return JSON.parse(m.content.slice(m.content.indexOf('{"temporalContext"')))}catch{return null}}).filter(v=>v?.originalRequest?.workId===row.work?.workId).map(v=>({availableFiles:v.availableFiles,workId:v.originalRequest.workId}));
if(isWork){check(row.reviewInputs.length>0,'actual independent foreground result review');const available=row.reviewInputs.at(-1)?.availableFiles||[];check((row.primaryRefs||[]).every(ref=>available.some(f=>f.ref===ref)),'model primary refs selected from actual availableFiles');}

check(!row.presentation.overflow,'overflow');check(!/\b(?:bindingId|sourceEntryId|tool_call_id|artifactRefs|inputSnapshotId)\b/.test(row.presentation.text),'execution details leaked');
for(const name of files){check(row.artifacts.some(a=>path.basename(a.path)===name&&a.exists&&a.actualDigest===a.digest),'registered verified artifact '+name);check(row.presentation.files.includes(name),'visible file '+name);}
if(!files.length)check(!row.presentation.files.length,'unrequested attachment');check(row.artifacts.every(a=>files.includes(path.basename(a.path))),'unrelated output');
if(id==='multiple-deliverables'){
check(Boolean(row.work?.team),'actual team execution');
const selected=row.deliveredFiles.find(f=>f.name==='packing.md');const artifact=row.artifacts.find(a=>a.snapshotPath===selected?.openPath);
const contents=artifact?.exists?fs.readFileSync(artifact.snapshotPath||artifact.path,'utf8'):'';
check(contents.includes('WATER-2L')&&!contents.includes('WATER-1L'),'latest revised member file');
row.latestMemberContent=contents;check(row.deliveredFiles.filter(f=>f.name==='packing.md').length===1,'only one latest packing file delivered');check(row.primaryRefs?.includes(selected?.ref),'latest packing file selected as primary');check(row.primaryRefs?.every(ref=>row.deliveredFiles.some(f=>f.ref===ref&&f.openPath)),'primary refs are registered delivered files');
const calls=[...new Map(requests.slice(offset).flatMap(r=>r.messages||[]).flatMap(m=>m.tool_calls||[]).map(c=>[c.id,c])).values()];
row.revisionCalls=calls.filter(c=>['write','edit'].includes(c.function?.name)&&String(c.function.arguments).includes('packing.md'));
check(row.revisionCalls.length>=2,'actual member write then revision tool calls');
}
if(id==='csv-analysis')check(/118/.test(row.presentation.text)&&/Coffee|咖啡/.test(row.presentation.text),'income summary');
if(id==='missing-facts')check(/无法|不能|不知道|不确定|需要|提供/.test(row.presentation.text)&&!/20\d\d[-年]\d/.test(row.presentation.text),'missing facts honesty');
if(id==='code-review')check(/NaN|0\s*\/\s*0/.test(row.presentation.text),'empty-array defect');
if(id==='multiple-deliverables'){
const front=message.workFeedback.report.summary.replace(/[*`]/g,'').trim();check(row.presentation.body.trim()===front,'foreground reviewed prose precedes raw structured conclusions');
check(row.presentation.details.filter(d=>d.label==='执行详情与来源').every(d=>!d.open),'execution details closed initially');
await rpc('Emulation.setDeviceMetricsOverride',{width:440,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,250));
check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'narrow viewport no horizontal overflow');
const narrow=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'multiple-deliverables-narrow.png'),Buffer.from(narrow.data,'base64'));
await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,250));
}
row.openClicks=[];
for(const name of files){const clicked=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const li=[...el.querySelectorAll('.bot-result-files li')].find(x=>x.querySelector('strong')?.innerText===${JSON.stringify(name)});const b=li?.querySelector('button');if(!b||b.getBoundingClientRect().height===0)return false;b.click();return true;})()`);await new Promise(r=>setTimeout(r,500));const error=await evaluate(`document.querySelector(${JSON.stringify(selector)})?.querySelector('.bot-result-attachments [role=alert]')?.innerText||''`);row.openClicks.push({name,clicked,error});check(clicked&&!error,'actual open-file click '+name);}
row.status=row.failures.length?'failed':'passed';console.log(JSON.stringify({id,status:row.status,failures:row.failures,calls:row.modelCalls}));
}catch(e){row.status='failed';row.error=String(e.stack||e);console.error(id,e);}persist();}
report.history=await history();report.actualModelSettings=[...new Map(requests.map(r=>[JSON.stringify([r.model,r.reasoning_effort,r.max_tokens,r.max_completion_tokens,r.temperature]),{model:r.model,reasoning_effort:r.reasoning_effort,max_tokens:r.max_tokens,max_completion_tokens:r.max_completion_tokens,temperature:r.temperature}])).values()];persist();
assert.equal(report.cases.filter(c=>c.status==='passed').length,6,'all six delivery cases');
};
