/** Real-model responsiveness: click -> host receipt -> rendered prose, never provider reasoning TTFT. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({send, until, evaluate, history, rpc, report, requests, rawUsageAudit, out, home}) => {
  report.measurementContract = {
    submit: 'Capture-phase actual composer submit-button click in renderer (Date.now).',
    hostReceipt: 'Persisted user.createdAt; receipt observed separately through host onMessageChanged.',
    visibleText: 'First animation frame where nonempty assistant prose has visible layout intersecting viewport; excludes placeholder, activity, references, metrics and actions. Not provider TTFT.',
    commentary: 'First host commentary segment and first actually visible DOM commentary, separately.',
    toolActivity: 'First host message.activity observation. Does not count as natural-language acknowledgement.',
    completion: 'First host terminal event, plus authoritative persisted final state.',
    calls: 'Transparent real-model proxy calls matched by last user prompt; foreground requires native work_create tool exposure, auxiliary calls counted separately; Work/background calls listed at end.',
    thresholds: 'At least one actual visible host receipt or model prose within 1500ms of click in this local acceptance run. Host receipt never counts as model prose. Pre-tool commentary compliance is reported separately.',
  };
  report.latencyCases = [];
  const checkpoint = () => fs.writeFileSync(path.join(out, 'latency-checkpoint.json'), JSON.stringify(report, null, 2));
  const install = async () => evaluate(`(() => {
    window.__latency?.unsubscribe?.(); window.__latency?.observer?.disconnect();
    const state = window.__latency = { rows: {}, clicks: [], pending: false };
    document.addEventListener('click', e => { if(e.target.closest('.bot-composer button[type=submit]')) state.clicks.push({at:Date.now(),text:document.querySelector('#bot-draft').value}); }, true);
    state.unsubscribe = window.api.botWork.onMessageChanged(event => {
      const m=event.message, r=state.rows[m.requestId] ||= {requestId:m.requestId};
      if(m.role==='user') {r.hostReceivedAt=m.createdAt; r.receiptObservedAt ||= Date.now(); r.prompt=m.text;}
      else {r.messageId=m.messageId; r.status=m.status;
        if(m.activity) {r.firstToolActivityAt ||= Date.now();r.firstTool ||= m.activity.tool;}
        if(m.segments?.some(s=>s.kind==='receipt'&&s.text.trim())) {r.firstHostReceiptSegmentAt ||= Date.now();r.hostReceiptText ||= m.segments.find(s=>s.kind==='receipt').text;}
        if(m.segments?.some(s=>s.kind==='commentary'&&s.text.trim())) {r.firstCommentaryAt ||= Date.now();r.firstCommentaryText ||= m.segments.find(s=>s.kind==='commentary'&&s.text.trim()).text;}
        if(['completed','failed','cancelled','unknown'].includes(m.status)) r.completedAt ||= Date.now();
      }
      scan();
    });
    const visible = e => {const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none';};
    function scan(){if(state.pending)return;state.pending=true;requestAnimationFrame(()=>{state.pending=false;
      for(const r of Object.values(state.rows)) {if(!r.messageId)continue;
        const article=document.querySelector('[data-message-id="'+r.messageId+'"]');if(!article)continue;
        const body=article.querySelector('.bot-assistant-content'); if(!body)continue;
        const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let n;const texts=[];
        while(n=walker.nextNode()) {const p=n.parentElement;if(n.textContent.trim()&&!p.closest('.bot-reply-placeholder,.bot-tool-activity,[role="status"],.bot-reply-segment-receipt,[data-segment-kind="receipt"]')&&visible(p))texts.push(n.textContent.trim());}
        if(texts.length&&!r.firstVisibleTextAt){r.firstVisibleTextAt=Date.now();r.firstVisibleText=texts.join(' ');}
        const receipt=body.querySelector('.bot-reply-segment-receipt,[data-segment-kind="receipt"]');
        if(receipt?.innerText.trim()&&visible(receipt)){r.firstVisibleReceiptAt ||= Date.now();r.firstVisibleReceiptText ||= receipt.innerText;}
        const commentary=body.querySelector('[data-segment-kind="commentary"],.bot-message-segment.commentary,.bot-reply-commentary,.bot-reply-segment-commentary');
        if(commentary?.innerText.trim()&&visible(commentary)){r.firstVisibleCommentaryAt ||= Date.now();r.firstVisibleCommentaryText ||= commentary.innerText;}
      }
    });}
    state.observer=new MutationObserver(scan);state.observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true});
    return true;
  })()`);
  await install();
  const allErrors=[];
  const run = async spec => {
    const start=requests.length;
    const row={id:spec.id,kind:spec.kind,prompt:spec.prompt};report.latencyCases.push(row);
    try {
      await send(spec.prompt);
      const user=(await history()).messages.filter(m=>m.role==='user').at(-1);row.requestId=user.requestId;
      await until(async()=>{const m=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===row.requestId);return m&&['completed','failed','cancelled','unknown'].includes(m.status);},spec.id+' terminal response');
      await new Promise(r=>setTimeout(r,150));
      row.answer=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===row.requestId);
      const observed=await evaluate(`JSON.parse(JSON.stringify({row:window.__latency.rows[${JSON.stringify(row.requestId)}],click:window.__latency.clicks.find(c=>c.text===${JSON.stringify(spec.prompt)})}))`);
      Object.assign(row, observed.row);row.submittedAt=observed.click?.at;
      row.hostReceivedAt ||= user.createdAt;
      row.providerRequestIndices=requests.map((r,i)=>({r,i})).filter(({r,i})=>i>=start&&JSON.stringify([...r.messages].reverse().find(m=>m.role==='user')?.content).includes(spec.prompt)).map(({i})=>i);
      row.foregroundRequestIndices=row.providerRequestIndices.filter(i=>requests[i].tools?.some(t=>t.function?.name==='work_create'));
      row.modelCallCount=row.foregroundRequestIndices.length;
      row.auxiliaryRequestIndices=row.providerRequestIndices.filter(i=>!row.foregroundRequestIndices.includes(i));
      row.auxiliaryModelCallCount=row.auxiliaryRequestIndices.length;
      row.totalCallsDuringCase=requests.length-start;
      row.providerTiming=rawUsageAudit.filter(a=>row.providerRequestIndices.includes(a.requestIndex));
      row.ms=Object.fromEntries(['hostReceivedAt','receiptObservedAt','firstVisibleReceiptAt','firstVisibleTextAt','firstCommentaryAt','firstVisibleCommentaryAt','firstToolActivityAt','completedAt'].map(k=>[k,k in row&&row.submittedAt?row[k]-row.submittedAt:null]));
      row.commentaryBeforeTool=row.firstToolActivityAt ? Boolean(row.firstCommentaryAt&&row.firstCommentaryAt<=row.firstToolActivityAt&&row.firstVisibleTextAt<=row.firstToolActivityAt) : null;
      row.errors=[];
      if(['simple','calculation','planning'].includes(spec.id)&&row.modelCallCount!==1)row.errors.push('direct answer must use exactly one foreground model call');
      row.toolResultCycles=row.foregroundRequestIndices.slice(1).map(i=>({requestIndex:i,hasToolResult:requests[i].messages.some(m=>m.role==='tool')}));
      if(row.toolResultCycles.some(c=>!c.hasToolResult))row.errors.push('extra foreground call without tool-result cycle');
      if(row.answer?.status!=='completed')row.errors.push('response did not complete: '+row.answer?.status);
      if(!row.firstVisibleTextAt)row.errors.push('no actually visible nonempty assistant prose observed');
      row.receiptVisibleAfterModel=await evaluate(`Boolean(document.querySelector('[data-message-id="${row.answer.messageId}"] .bot-reply-segment-receipt,[data-message-id="${row.answer.messageId}"] [data-segment-kind="receipt"]'))`);
      if(row.firstVisibleTextAt&&row.receiptVisibleAfterModel)row.errors.push('host receipt still rendered after model prose');
      if(spec.expected&&!spec.expected.test(row.answer?.text||''))row.errors.push('answer missing expected evidence');
      if(spec.tool&&!row.firstToolActivityAt)row.errors.push('expected actual tool activity absent');
      if(row.firstToolActivityAt&&!row.commentaryBeforeTool)row.complianceNote='No rendered model prose/commentary before first tool activity';
      row.firstVisibleResponseMs=Math.min(...[row.firstVisibleReceiptAt,row.firstVisibleTextAt].filter(Number.isFinite))-row.submittedAt;
      if(!Number.isFinite(row.firstVisibleResponseMs)||row.firstVisibleResponseMs>1500)row.errors.push('first visible receipt or model prose exceeds 1500ms: '+row.firstVisibleResponseMs);
      if(spec.id==='web'&&!/https?:\/\//.test(row.answer?.text||''))row.errors.push('web response lacks a source URL');
      if(row.errors.length)allErrors.push(...row.errors.map(e=>spec.id+': '+e));
    } catch(e){row.error=String(e.stack||e);allErrors.push(spec.id+': '+String(e));}
    checkpoint();console.log(JSON.stringify({id:row.id,ms:row.ms,modelCalls:row.modelCallCount,errors:row.errors,error:row.error}));
    return row;
  };
  await run({id:'simple',kind:'direct simple answer',prompt:'法国的首都是哪里？',expected:/巴黎|Paris/i});
  await run({id:'calculation',kind:'calculation and explanation',prompt:'一件商品原价240元，先打八折再减30元，实际付多少钱？简单解释一下计算顺序。',expected:/162/});
  await run({id:'web',kind:'real public web information',prompt:'帮我查一下 Node.js 官网现在推荐的 LTS 版本，给我官网来源链接。',tool:true});
  // This extra natural setup turn is measured but is not one of the six required task classes.
  await run({id:'memory-setup',kind:'memory fixture setup',prompt:'请记住：我的旅行清单代号是银杏5739。',expected:/5739|记/});
  // Archive to require actual persistent recall, not just prior text in this conversation.
  try {
    await until(async()=>JSON.stringify(await evaluate("window.api.memory.list({scopeType:'bot',scopeId:'bot-mybuddy-default',status:'active'})")).includes('银杏5739'),'memory fixture persisted');
    await evaluate('document.querySelector(".bot-new-conversation").click()');
    await until(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'),'archive dialog');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');
    await until(async()=>(await history()).messages.length===0,'new empty conversation');
  } catch(e){allErrors.push('memory isolation: '+String(e));}
  await run({id:'memory',kind:'persistent private memory read',prompt:'我的旅行清单代号是什么？',expected:/银杏5739/});
  await run({id:'planning',kind:'task planning',prompt:'我周六只有两小时整理家里，厨房、衣柜和书桌都很乱。帮我排一个可执行的时间计划。',expected:/厨房/});
  const work=await run({id:'work',kind:'long Work delegation',prompt:`帮我开一个后台任务，详细拟定一份新员工入职第一周的培训计划，覆盖每天上午下午的安排、负责人、所需材料和验收标准，并自己检查有没有遗漏。最后将计划作为文字结果给我，不需要写文件。所有工作限于这次测试，不要联系任何人。` ,tool:true});
  report.workIds=work.answer?.workIds||[];
  try {
    await until(async()=>{const rows=await evaluate('window.api.botWork.listWorks(true)');report.works=rows;report.workObservedAt=Date.now();return report.workIds.length>0&&report.workIds.every(id=>rows.some(w=>w.workId===id&&w.lifecycle==='closed'));},'delegated Work completion');
    if(report.modelConfiguration?.mode!=='explicit-output-pressure' && report.works.some(w=>report.workIds.includes(w.workId)&&w.closureConclusion!=='succeeded'))allErrors.push('Work did not succeed');
  }catch(e){allErrors.push('Work result: '+String(e));}
  // Inspect only this isolated test profile. Review state is separate from the
  // public answer: a compressed rewrite must not hide failed native executions.
  try {
    const db = require('better-sqlite3')(path.join(home,'.mybuddy','app.db'),{readonly:true,fileMustExist:true});
    try {
      report.workReviewAudit = report.workIds.map(workId=>({workId,
        turns:db.prepare('SELECT t.binding_id,t.state,t.attempts,t.error FROM work_completion_turns t JOIN work_execution_bindings b ON b.binding_id=t.binding_id WHERE b.work_id=?').all(workId),
        recovery:db.prepare('SELECT r.source_binding_id,r.mode FROM work_automatic_recovery r JOIN work_execution_bindings b ON b.binding_id=r.source_binding_id WHERE b.work_id=?').all(workId),
        executions:db.prepare('SELECT binding_id,status,settlement_note FROM work_execution_bindings WHERE work_id=? ORDER BY admitted_at').all(workId)}));
    } finally {db.close();}
    for(const audit of report.workReviewAudit) {
      if(audit.turns.some(t=>t.state==='running'))allErrors.push('closed Work retains running result review');
      const superseded=new Set(audit.recovery.filter(r=>r.mode==='recover'||r.mode==='readback').map(r=>r.source_binding_id));
      if(audit.turns.some(t=>superseded.has(t.binding_id)))allErrors.push('result review raced an automatic recovery decision');
    }
    if(report.modelConfiguration?.mode==='explicit-output-pressure') {
      const executions=report.workReviewAudit.flatMap(row=>row.executions);
      if(!executions.some(e=>e.status==='failed'&&/length|长度|empty reply/i.test(e.settlement_note||'')))allErrors.push('output-pressure run did not exercise truncation or empty-output recovery');
      if(executions.length<2)allErrors.push('output-pressure failure did not receive an automatic continuation');
    }
  } catch(e){allErrors.push('Work review audit: '+String(e));}
  // Reload reconstructs persistent segments; compare exact DTOs as well as DOM prose.
  const before=(await history()).messages.filter(m=>m.role==='assistant').map(m=>({messageId:m.messageId,text:m.text,segments:m.segments}));
  await rpc('Page.reload');
  await until(()=>evaluate('Boolean(window.api?.botWork&&document.querySelector("#bot-draft"))'),'renderer reconnect');
  const after=(await history()).messages.filter(m=>m.role==='assistant').map(m=>({messageId:m.messageId,text:m.text,segments:m.segments}));
  report.reconnect={before,after};
  try{assert.deepEqual(after,before);report.reconnect.passed=true;}catch(e){allErrors.push('persistent reload: '+String(e));}
  await install();
  // Two independently submitted real-model requests, then cancel only the long reply.
  await send('请详细介绍太阳系八大行星，每颗分别写地貌、大气、卫星、探测历史和三个有趣事实。');
  const long=(await history()).messages.filter(m=>m.role==='user').at(-1);
  await send('顺便问一句，一周有几天？');
  const quick=(await history()).messages.filter(m=>m.role==='user').at(-1);
  try{
    const longAnswer=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===long.requestId);
    report.concurrent={longRequestId:long.requestId,quickRequestId:quick.requestId};
    await evaluate(`document.querySelector('[data-message-id="${longAnswer.messageId}"] .bot-message-stop')?.click()`);
    await until(async()=>(await history()).messages.some(m=>m.requestId===quick.requestId&&m.role==='assistant'&&m.status==='completed'),'independent quick reply');
    const h=await history();report.concurrent.answers=h.messages.filter(m=>m.role==='assistant'&&[long.requestId,quick.requestId].includes(m.requestId));
    assert.equal(report.concurrent.answers.find(m=>m.requestId===long.requestId)?.status,'cancelled');
    assert(/7|七/.test(report.concurrent.answers.find(m=>m.requestId===quick.requestId)?.text));
    report.concurrent.structuralPassed=true;
    const quickText=report.concurrent.answers.find(m=>m.requestId===quick.requestId)?.text||'';
    report.concurrent.staleStatusClaim=/(八大行星|太阳系|行星)[\s\S]*?(还在|生成|稍后|完成后|继续|会直接)/.test(quickText);
    assert(!report.concurrent.staleStatusClaim,'quick answer makes an unsupported continuing-work promise about the cancelled request');
    report.concurrent.passed=true;
  }catch(e){allErrors.push('concurrent cancellation: '+String(e));}
  report.requiredClassCount=report.latencyCases.filter(r=>r.id!=='memory-setup').length;
  report.totalModelCalls=requests.length;report.providerCalls=requests.map((r,i)=>({requestIndex:i,kind:r.tools?.some(t=>t.function?.name==='work_create')?'foreground':String(r.messages.find(m=>m.role==='system')?.content).includes('Memory Kernel')?'memory-extraction':r.tools?.length?'worker':'background-review',timing:rawUsageAudit.find(a=>a.requestIndex===i)}));report.responsivenessErrors=allErrors;checkpoint();
  assert.equal(report.requiredClassCount,6);
  assert.equal(allErrors.length,0,allErrors.join('\n'));
  report.checks.push('Six natural real-model task classes, actual visible prose timings, host receipts, commentary/tool order, audited Work closure, persistent reload, and concurrent request cancellation');
};
