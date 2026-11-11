/** Real-model cache, foreground contention and cancellation. No injected failure. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({send,until,evaluate,history,report,requests,rawUsageAudit,out,home,botId}) => {
  report.measurementContract = {
    kind:'Real model; isolated pnpm dev renderer/IPC. No production data, crash, or fake provider delay.',
    cache:'Exact wire-prefix equality and provider cached-token evidence are reported separately.',
    fairness:'Finite six-request burst, not a starvation or general fairness proof.',
    cancellation:'Host terminal state/API/proxy close are distinct; provider compute cancellation is not observable.',
  };
  const checkpoint=()=>fs.writeFileSync(path.join(out,'performance-checkpoint.json'),JSON.stringify(report,null,2));
  const db=require('better-sqlite3')(path.join(home,'.mybuddy/app.db'),{readonly:true,fileMustExist:true});
  const storage=()=>({at:Date.now(),pageCount:db.pragma('page_count',{simple:true}),pageSize:db.pragma('page_size',{simple:true}),
    files:['app.db','app.db-wal','app.db-shm'].map(name=>({name,bytes:fs.existsSync(path.join(home,'.mybuddy',name))?fs.statSync(path.join(home,'.mybuddy',name)).size:0})),
    requestRuns:db.prepare('SELECT COUNT(*) rows,COALESCE(SUM(length(CAST(context_json AS BLOB))),0) contextBytes,COALESCE(SUM(length(CAST(transcript_json AS BLOB))),0) transcriptBytes FROM bot_request_runs').get()});
  const latestUser=r=>JSON.stringify([...r.messages].reverse().find(m=>m.role==='user')?.content);
  const indices=marker=>requests.flatMap((r,i)=>latestUser(r).includes(marker)?[i]:[]);
  const terminal=s=>['completed','failed','cancelled','unknown'].includes(s);
  try {
    report.storage=[storage()];report.cacheCases=[];
    const csv=['id,region,units,price',...Array.from({length:1200},(_,i)=>[i+1,['east','west','north'][i%3],i%9+1,10+i%7].join(','))].join('\n');
    const specs=[
      ['extraction','这是虚构表格。只列出列名和首末id，40字以内。\n'+csv,/1200/],
      ['calculation','一件商品原价240元，先打八折再减30元，实际付多少钱？只答计算结果。',/162/],
      ['translation','把“Please review the inventory before Friday.”翻译成简短中文，只给译文。',/周五|星期五/],
      ['classification','将 apple、table、banana 按水果和家具分类，只给分类结果。',/apple/],
      ['summarization','将“周一收集需求，周二实现，周三测试，周四修复，周五上线。”浓缩为一句概括，30字以内。',/需求|开发|实现|测试|上线/],
      ['planning','为60分钟整理书桌安排三步计划，只列每步分钟数和动作，60字以内。',/分钟|分/],
    ];
    let previous;
    for(let i=0;i<specs.length;i++){
      const [kind,text,expected]=specs[i],marker='P5_CACHE_'+i;
      const row={kind,marker,submittedAt:Date.now()};report.cacheCases.push(row);
      await send(marker+' 当前回合仅回答下面问题，不调用工具，不创建Work，不保存长期记忆。\n'+text);
      const user=(await history()).messages.filter(m=>m.role==='user').at(-1);row.requestId=user.requestId;
      await until(async()=>(await history()).messages.some(m=>m.requestId===row.requestId&&m.role==='assistant'&&terminal(m.status)),marker);
      const answer=(await history()).messages.find(m=>m.requestId===row.requestId&&m.role==='assistant');
      row.wallMs=Date.now()-row.submittedAt;row.status=answer.status;row.answer=answer.text;row.providerIndices=indices(marker);
      assert.equal(row.providerIndices.length,1,'one real inference per cache case');
      const index=row.providerIndices[0];row.timing=rawUsageAudit.find(a=>a.requestIndex===index);
      if(previous!==undefined){
        row.previousWireMessages=requests[previous].messages.length;
        row.exactPrefix=JSON.stringify(requests[index].messages.slice(0,row.previousWireMessages))===JSON.stringify(requests[previous].messages);
        assert(row.exactPrefix,'previous wire messages remain an exact prefix');
      }
      previous=index;assert.equal(answer.status,'completed');assert.match(answer.text,expected);
      report.storage.push(storage());checkpoint();console.log(JSON.stringify({kind,wallMs:row.wallMs,prefix:row.exactPrefix,usage:row.timing?.usage}));
    }
    const prior=await history();
    await evaluate('window.api.botWork.archiveConversation('+JSON.stringify(botId)+','+JSON.stringify(prior.conversationId)+')');
    await until(async()=>!(await history()).messages.length,'fresh burst conversation');
    await evaluate("window.__p5Events=[];window.__p5Unsubscribe=window.api.botWork.onMessageChanged(e=>{const m=e.message;if(m.role==='assistant')window.__p5Events.push({requestId:m.requestId,status:m.status,at:Date.now(),hasText:!!m.text.trim()});});");
    const other=await evaluate("window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'性能隔离对照',responsibilitySummary:'只回答本次测试问题'})");
    assert(other.ok);report.burst=[];
    const burst=[
      ['explanation','请详细解释太阳系八大行星的不同特点，约1200字。'],
      ['translation','请写一篇约1000字的英文城市旅行介绍，并将全文逐段翻译为中文。'],
      ['creative','请写一篇约1200字的科幻短篇故事，主题是图书馆机器人。'],
      ['calculation','17乘19等于多少？只答数字。'],
      ['status','当前前台请求的状态和进度是什么？查询真实状态后简短回答，不停止任何请求。'],
      ['classification','请将苹果、香蕉、桌子分为水果和家具两类，只列结果。'],
    ];
    for(let i=0;i<burst.length;i++){
      const [kind,text]=burst[i],marker='P5_BURST_'+i,target=i===5?other.bot.botId:botId;
      const input={botId:target,requestId:'performance-'+Date.now()+'-'+i,text:marker+' 只在前台回答，不创建后台Work，不保存长期记忆。'+text};
      const row={kind,marker,botId:target,requestId:input.requestId,submittedAt:Date.now()};report.burst.push(row);
      row.receipt=await evaluate('window.api.botWork.sendMessage('+JSON.stringify(input)+')');row.receivedAt=Date.now();
    }
    const first=report.burst[0];
    await until(()=>indices(first.marker).length>0,'selected real provider call started');
    // Wait for actual headers so cancellation has an observable provider connection.
    await until(()=>rawUsageAudit.some(a=>indices(first.marker).includes(a.requestIndex)),'selected provider connection observable');
    report.preCancelActive=await evaluate('window.api.botWork.activeRequests()');
    report.cancel={requestId:first.requestId,requestedAt:Date.now()};
    await evaluate('window.api.botWork.cancelSend('+JSON.stringify(first.botId)+','+JSON.stringify(first.requestId)+')');
    report.cancel.apiReturnedAt=Date.now();checkpoint();
    const getAnswer=async row=>(await evaluate('window.api.botWork.history({botId:'+JSON.stringify(row.botId)+'})')).messages.find(m=>m.requestId===row.requestId&&m.role==='assistant');
    await until(async()=>{for(const row of report.burst){if(!terminal((await getAnswer(row))?.status))return false;}return true;},'burst terminal');
    report.events=await evaluate('window.__p5Events');
    for(const row of report.burst){
      const answer=await getAnswer(row);row.status=answer.status;row.answer=answer.text;row.providerIndices=indices(row.marker);
      row.timings=rawUsageAudit.filter(a=>row.providerIndices.includes(a.requestIndex));
      row.providerAdmittedAt=row.timings[0]?.requestStartedAt;
      const events=report.events.filter(e=>e.requestId===row.requestId);
      row.hostRunningAt=events.find(e=>e.status==='running')?.at;row.hostTerminalAt=events.find(e=>terminal(e.status))?.at;
      row.queueToHostRunningMs=row.hostRunningAt-row.submittedAt;row.queueToProviderMs=row.providerAdmittedAt-row.submittedAt;
      assert.equal(row.status,row===first?'cancelled':'completed');
    }
    report.cancel.persistedMs=first.hostTerminalAt-report.cancel.requestedAt;
    report.cancel.apiMs=report.cancel.apiReturnedAt-report.cancel.requestedAt;
    report.cancel.proxyClosedAt=first.timings[0]?.downstreamClosedAt??null;
    report.cancel.proxyClosedMs=report.cancel.proxyClosedAt?report.cancel.proxyClosedAt-report.cancel.requestedAt:null;
    report.cancel.siblingsCompleted=report.burst.slice(1).every(r=>r.status==='completed');
    assert.match(report.burst[3].answer,/323/);assert.match(report.burst[5].answer,/水果/);
    report.storage.push(storage());report.rawUsageAudit=rawUsageAudit;
    report.checks.push('Six real-model task types; five exact native wire prefixes; provider cache usage independently recorded.');
    report.checks.push('Six-request real-model contention; selected cancellation; ordinary/control/other-Bot admissions; five siblings completed.');
    checkpoint();console.log(JSON.stringify({burst:report.burst.map(r=>({kind:r.kind,status:r.status,queueToProviderMs:r.queueToProviderMs})),cancel:report.cancel}));
  }finally{db.close();}
};
