/** Actual provider + Electron composer. Synthetic learning content, no fabricated calls or replies. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({send, foregroundDone, until, evaluate, history, rpc, report, requests, out, botId, setBotId}) => {
  const owner = botId;
  const created = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'学习搭子',responsibilitySummary:'回答同伴的编程、数学、语言和学习咨询，严格区分历史记录与当前回答'})`);
  assert(created.ok);
  const peer = created.bot.botId;
  const select = async (id, name) => {
    await until(() => evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})`), 'Bot visible');
    await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);
    setBotId(id);
    await until(() => evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent===${JSON.stringify(name)}`), 'selected Bot');
  };
  await select(peer, '学习搭子');
  const marker = '水杉课堂731';
  await send(`用两句话解释 Python 列表切片的浅拷贝，把这次课堂笔记命名为“${marker}”。这是普通学习问答，不是长期用户事实。`);
  await foregroundDone();
  await until(async () => (await evaluate('window.api.memory.turns({limit:100})')).every(t => !['pending','processing'].includes(t.extractionState)), 'history capture settled');
  assert(!JSON.stringify(await evaluate(`window.api.memory.list({scopeType:'bot',scopeId:${JSON.stringify(peer)},status:'active'})`)).includes(marker),'ordinary lesson is not a persistent personal fact');
  const targetBefore = await history();
  await select(owner, 'MyBuddy');
  report.peerFollowup = {recipientBotId:peer,cases:[],observedStatuses:[],fixtures:'Today-only real Q&A in a new isolated profile; no yesterday source exists.'};
  let capturedRunning = false;
  const waitAnswer = async prompt => {
    let answer;
    await until(async () => {
      const h=await history(), user=h.messages.find(m=>m.role==='user'&&m.text===prompt);
      answer=user&&h.messages.find(m=>m.role==='assistant'&&m.requestId===user.requestId);
      for (const c of answer?.botCalls||[]) {
        if (!report.peerFollowup.observedStatuses.includes(c.status)) report.peerFollowup.observedStatuses.push(c.status);
        if (!capturedRunning && c.status==='running') {
          capturedRunning=true;
          fs.writeFileSync(path.join(out,'peer-followup-running.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
        }
      }
      return answer&&!['queued','running','unknown'].includes(answer.status);
    }, 'completed '+prompt.slice(0,35));
    assert.equal(answer.status,'completed',answer.error); return answer;
  };
  const sourceSeed='先只复述这段既有团队摘要：昨天团队做过 Python 浅拷贝整理。当前不要联系学习搭子，也不要把团队摘要说成你跟它实际交流过。';
  await send(sourceSeed); const seed=await waitAnswer(sourceSeed); assert.equal(seed.botCalls?.length||0,0);
  const cases=[
    {type:'上下文隐式继续与昨日核实',prompt:'继续，你昨天从学习搭子学到了什么',contact:true,check:a=>assert(a.botCalls.some(c=>/没有|无法|未|暂无|缺少|不确定|没找到/.test(c.replyText)), 'new profile has no yesterday source: recipient must disclose that limit')},
    {type:'真实回复历史复述',prompt:'不要再问学习搭子，复述它刚才实际说的内容，并区分现在确认的回答和昨天已经发生的交流。',contact:false,check:a=>assert(/昨天|昨日/.test(a.text))},
    {type:'代词目标数学咨询',prompt:'再问它一个独立数学问题：17乘23是多少？请给出它的计算结果。',contact:true,check:a=>assert(a.botCalls.some(c=>/391/.test(c.replyText)))},
    {type:'名字文本翻译不触发联系',prompt:'不要联系任何Bot。只把这句话翻译成英文：“学习搭子今天学得很好。”',contact:false,check:a=>assert(/learn|stud/i.test(a.text))},
    {type:'代码只读咨询',prompt:'帮我问学习搭子，Python表达式 [x*x for x in range(3)] 返回什么，为什么？不需要创建或执行文件。',contact:true,check:a=>assert(a.botCalls.some(c=>/0/.test(c.replyText)&&/1/.test(c.replyText)&&/4/.test(c.replyText)))},
    {type:'纯历史审计不补造联络',prompt:'昨天你们实际聊过什么？只核对已有通信记录，不要补问，也不要把今天的回答说成昨天的交流。',contact:false,check:a=>assert(/没有|无法|未|不能|没查到/.test(a.text))},
    {type:'当日真实学习记录召回',prompt:'现在问学习搭子：今天个人学习对话里能确认的课堂笔记名称是什么？请它按真实历史回答。',contact:true,check:a=>assert(a.botCalls.some(c=>c.replyText?.includes(marker)))},
    {type:'已有原文解释不重复联络',prompt:'只根据前面学习搭子已经给出的数学回复，解释391是怎么得出的，不要重新联系它。',contact:false,check:a=>assert(/391/.test(a.text))},
  ];
  for (const c of cases) {
    const offset=requests.length, started=Date.now(); let answer;
    try {
      await send(c.prompt); answer=await waitAnswer(c.prompt); const calls=answer.botCalls||[];
      if(c.contact) assert(calls.length&&calls.every(x=>x.targetBotId===peer&&x.status==='completed'&&x.replyText?.trim()),'real target reply required');
      else assert.equal(calls.length,0,'historical/translation request must not contact a Bot');
      c.check(answer);
      report.peerFollowup.cases.push({type:c.type,prompt:c.prompt,expectedContact:c.contact,status:'passed',requestId:answer.requestId,answer:answer.text,calls,modelCalls:requests.length-offset,durationMs:Date.now()-started});
    } catch(error) { report.peerFollowup.cases.push({type:c.type,prompt:c.prompt,expectedContact:c.contact,status:'failed',error:String(error),requestId:answer?.requestId,answer:answer?.text,calls:answer?.botCalls,modelCalls:requests.length-offset,durationMs:Date.now()-started}); }
    fs.writeFileSync(path.join(out,'peer-followup-progress.json'),JSON.stringify(report.peerFollowup,null,2));
  }
  assert.equal(report.peerFollowup.cases.length,8,'complete all eight different task types, even after an assertion failure');
  const beforeReload=await history();
  assert.equal((await evaluate(`window.api.botWork.history({botId:${JSON.stringify(peer)}})`)).messages.length,targetBefore.messages.length,'no synthetic recipient private messages');
  assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length,0,'read-only collaboration does not create Work/team');
  await until(()=>evaluate('document.querySelectorAll(".bot-call-thread").length >= 4'),'actual communication UI');
  await evaluate('document.querySelectorAll(".bot-call-thread").forEach(e=>e.open=false)');
  const summaries=await evaluate('[...document.querySelectorAll(".bot-call-thread summary")].map(e=>e.innerText)');
  assert(summaries.every(t=>t.includes('已收到')&&t.includes('学习搭子')),'completed contact visible without expanding');
  await evaluate('[...document.querySelectorAll(".bot-call-thread")].at(-1)?.scrollIntoView({block:"center"})');
  fs.writeFileSync(path.join(out,'peer-followup-collapsed.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  await evaluate('document.querySelectorAll(".bot-call-thread").forEach(e=>e.open=true)');
  const visible=await evaluate('[...document.querySelectorAll(".bot-call-thread")].map(e=>e.innerText).join("\\n")');
  assert(visible.includes(marker)&&visible.includes('391'),'original recipient replies visible');
  await evaluate('[...document.querySelectorAll(".bot-call-thread")].at(-1)?.scrollIntoView({block:"center"})');
  fs.writeFileSync(path.join(out,'peer-followup-original-replies.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  await rpc('Page.reload');
  await until(()=>evaluate('Boolean(window.api?.botWork?.history && document.querySelector("#bot-draft"))'),'reload');
  const restored=await history();
  for(const old of beforeReload.messages.filter(m=>m.botCalls?.length)) assert.deepEqual(restored.messages.find(m=>m.messageId===old.messageId)?.botCalls,old.botCalls,'same durable call identity and replies');
  assert(report.peerFollowup.observedStatuses.includes('running'),'actual in-flight state');
  const failures=report.peerFollowup.cases.filter(c=>c.status==='failed');
  assert.equal(failures.length,0,JSON.stringify(failures));
  report.checks.push('eight actual-model collaboration task types: contextual yesterday follow-up, historical replay, pronoun math, translation, code, historical audit, today history, answer reuse; actual status/original reply/reload and no false Work');
};
