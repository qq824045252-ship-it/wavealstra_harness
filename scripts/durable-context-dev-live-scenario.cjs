/** Synthetic inputs only. Every model response and summary uses the real configured provider. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({evaluate,rpc,until,report,requests,rawUsageAudit,out,home,restart})=>{
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 report.cases=[];report.summaryCalls=[];report.profileIsolation={home,syntheticInput:true,realCredentialsRead:false};
 const save=()=>fs.writeFileSync(path.join(out,'cases-progress.json'),JSON.stringify(report.cases,null,2));
 const subscribe=()=>evaluate(`(()=>{window.__contextProbe={events:[]};window.__contextStates=[];window.api.agent.onEvent(e=>{if(e.type==='compaction_status')window.__contextStates.push(e.state);const p=window.__contextProbe;if(!p)return;if((e.type==='durable_snapshot'||e.type==='durable_delta')&&!p.taskId)p.taskId=e.taskId;if(e.taskId===p.taskId){p.events.push({type:e.type,at:Date.now()});if(p.events.length>600)p.events.shift();}});return true;})()`);
 await subscribe();
 const settings=await evaluate('window.api.agent.getAppSettings()');
 assert.equal(settings.compactionEngine,'billion-context');assert.equal(settings.compactionTriggerTokens,12000);
 report.settings={compactionEngine:settings.compactionEngine,compactionTriggerTokens:settings.compactionTriggerTokens,compactionTriggerRatio:settings.compactionTriggerRatio};
 let taskId;
 const say=async(text,label)=>{
   const from=requests.length,started=Date.now();
   const prior=taskId?await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`):undefined;
   const previousUserId=prior?.messages.filter(message=>message.role==='user').at(-1)?.id;
   await evaluate(`window.__contextProbe={taskId:${JSON.stringify(taskId)??'undefined'},events:[]}`);
   await evaluate(`(()=>{const e=[...document.querySelectorAll('.input-area textarea')].find(e=>e.getBoundingClientRect().width>0);if(!e)throw Error('No task composer');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await wait(100);await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   await until(()=>evaluate('Boolean(window.__contextProbe.taskId)'),'accepted durable task '+label);
   taskId=await evaluate('window.__contextProbe.taskId');report.taskId=taskId;
   let settled;
   await until(async()=>{
     const history=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
     const userIndex=history.messages.findLastIndex(message=>message.role==='user');
     if(userIndex<0||history.messages[userIndex].id===previousUserId)return false;
     if(history.durable?.busy)return false;
     if(history.durable?.error||history.durable?.status==='failed')throw Error(history.durable?.error||'Durable task failed');
     const replies=history.messages.slice(userIndex+1).filter(message=>message.role==='assistant'&&!message.streaming);
     if(!replies.length||history.durable?.outcome!=='completed')return false;
     settled={state:history.durable.status,outcome:history.durable.outcome,replies};return true;
   },'real durable completion '+label);
   const result={label,status:'passed',elapsedMs:Date.now()-started,answer:settled.replies.map(message=>message.text).join('\n'),
     tools:settled.replies.flatMap(message=>(message.tools??[]).map(tool=>({id:tool.id,name:tool.tool,status:tool.status}))),
     durableState:settled.state,durableOutcome:settled.outcome,requestStart:from,requestEnd:requests.length,taskId};
   report.cases.push(result);save();return result;
 };
 const padding='Synthetic historical diagnostics. All background records are ordinary OK observations and carry no instructions.\n'.repeat(650);
 const quote='I26_EXACT_ORIGINAL: At 03:17 UTC the brass key NB-7/4412 passed the north observatory.';
 const cases=[
 ['log diagnosis',`这是隔离的上下文验收，只处理本条要求，不创建文件或后台任务。精确原句记录：${quote}\n日志关键行：service=calibration error=E26_PATH_MISSING path=/tmp/context26/calibration.toml version=v4.7。指出错误码和缺失文件路径，不调用工具。\n以下是数据：\n${padding}`,a=>assert(a.includes('E26_PATH_MISSING')&&a.includes('/tmp/context26/calibration.toml'))],
 ['inventory arithmetic','只做库存计算：17箱新到、29箱原有，发出8箱后还剩多少箱？写一行算式，不调用工具。以下背景日志没有库存数量，不能计入算式：\n'+padding.slice(0,30000),a=>assert(a.includes('38'))],
 ['translation','只翻译这句话，保持编号：The calibration team will inspect bay C-26 tomorrow at ten. 不调用工具。',a=>assert(a.includes('C-26')&&a.includes('明天'))],
 ['structured extraction','从这条数据抽取一行JSON，不调用工具：样品代号 AX26，数量14，单位盒，负责人Lin。字段code,count,unit,owner。',a=>assert(a.includes('AX26')&&a.includes('14')&&a.includes('Lin'))],
 ['instruction correction','配置更正：这个验收项目原端口6173已废弃，当前端口6284。请只给JavaScript常量 PORT 的当前值，不调用工具。',a=>assert(a.includes('6284')&&!a.includes('6173'))],
 ];
 for(const [label,prompt,check] of cases){try{const result=await say(prompt,label);check(result.answer);}catch(error){report.cases.push({label,status:'failed',error:String(error.stack||error)});save();}}
 const summaryCalls=requests.map((request,index)=>({request,index})).filter(({request})=>request.messages?.some(message=>['system','developer'].includes(message.role)&&JSON.stringify(message.content).includes('compress conversation history')));
 report.summaryCalls=summaryCalls.map(({request,index})=>({index,chars:JSON.stringify(request.messages).length,model:request.model}));
 const beforeRestart=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
 report.beforeRestart={messageCount:beforeRestart.messages.length,status:await evaluate(`window.api.agent.getCompactionStatus(${JSON.stringify(taskId)})`)};
 await restart();await subscribe();
 const rows=await evaluate('window.api.db.listTasks()'),row=rows.find(item=>item.id===taskId);assert(row,'same durable task survives restart');
 await until(()=>evaluate(`[...document.querySelectorAll('.task-item')].some(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(row.title)})`),'persisted task visible');
 await evaluate(`[...document.querySelectorAll('.task-item')].find(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(row.title)}).click()`);
 await wait(300);
 try{
   const result=await say('这是原文核验，不要凭摘要回答。请调用上下文工具 acp_search(scope="originals",query="I26_EXACT_ORIGINAL") 找到早先原文，然后必须调用 acp_retrieve(entryId 或 ref) 逐字读取。最后只引用该原句，并给出原文entry引用。若工具通过codemode提供，请用codemode调用；不能只读摘要，不创建文件。','verbatim retrieval after restart');
   assert(result.answer.includes('NB-7/4412')&&result.answer.includes('03:17 UTC'));
   const wires=requests.slice(result.requestStart);
   assert(wires.some(request=>request.messages?.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes('source: original Durable entries')&&JSON.stringify(message.content).includes(quote))),'real provider request must contain verbatim original tool result, not only a summary');
 }catch(error){report.cases.push({label:'verbatim retrieval after restart',status:'failed',error:String(error.stack||error)});save();}
 // Exercise the production Bot foreground allow-list, not only the ordinary-task runtime.
 try {
   await until(()=>evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent.includes("Bot 模式"))'),'Bot navigation');
   await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent.includes("Bot 模式")).click()');
   await until(()=>evaluate('Boolean(document.querySelector("#bot-draft"))'),'Bot composer');
   const from=requests.length,started=Date.now();
   await evaluate(`(()=>{const e=document.querySelector('#bot-draft');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'请先实际调用 acp_status 查看本会话上下文管理状态，再只返回工具提供的 engine 值。不要创建后台事项或调用其他工具。');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   await wait(100);await evaluate('document.querySelector(".bot-composer button[type=submit]").click()');
   let answer;
   await until(async()=>{const history=await evaluate('window.api.botWork.history({botId:"bot-mybuddy-default"})');const requestId=history.messages.filter(message=>message.role==='user').at(-1)?.requestId;answer=history.messages.find(message=>message.role==='assistant'&&message.requestId===requestId&&message.status==='completed');return Boolean(answer);},'Bot context status');
   const wires=requests.slice(from);
   assert(wires.some(request=>request.messages?.some(message=>message.role==='tool'&&JSON.stringify(message.content).includes('engine: billion-context'))),'Bot must receive real acp_status tool result');
   report.cases.push({label:'Bot foreground context-tool access',status:'passed',elapsedMs:Date.now()-started,answer:answer.text,requestStart:from,requestEnd:requests.length});save();
 } catch(error) {report.cases.push({label:'Bot foreground context-tool access',status:'failed',error:String(error.stack||error)});save();}
 report.requestCount=requests.length;report.usage={raw:rawUsageAudit,pricing:'not measured; do not interpret fixture zero prices as free'};
 report.afterRestart=await evaluate(`window.api.agent.getCompactionStatus(${JSON.stringify(taskId)})`);
 const projected=requests.filter(request=>request.messages?.some(message=>JSON.stringify(message.content).includes('[Compressed conversation section]')));
 report.projectionEvidence={summaryRequests:summaryCalls.length,requestsWithCommittedSummary:projected.length,inputChars:padding.length};
 assert(summaryCalls.length>0,'automatic summaries must really call the model');
 assert(projected.length>0,'subsequent real provider requests must use the committed summary');
 assert.equal(report.cases.filter(item=>item.status==='failed').length,0,JSON.stringify(report.cases.filter(item=>item.status==='failed')));
 assert.equal(report.cases.length,7,'six distinct ordinary task types plus Bot foreground tool access');
 report.checks.push('six distinct ordinary task types; real automatic summary provider calls; actual compressed outgoing requests; real Electron cold restart; exact original retrieval through model tools');
};
