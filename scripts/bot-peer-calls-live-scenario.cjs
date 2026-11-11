/** Six different real recipient tasks through the actual Electron composer and provider. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({send, foregroundDone, until, evaluate, history, rpc, report, requests, out, botId, setBotId}) => {
  const owner = botId;
  const created = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'学习搭子',responsibilitySummary:'学习编程、语言、数学与规划；直接回答同伴的只读咨询'})`);
  assert(created.ok);
  const peer = created.bot.botId;
  const select = async (id, name) => {
    await until(() => evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})`), 'Bot is visible');
    await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);
    setBotId(id);
    await until(() => evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent===${JSON.stringify(name)}`), 'selected Bot');
  };
  await select(peer, '学习搭子');
  const marker = '水杉学习记录731';
  await send(`用两句话解释 Python 列表切片的浅拷贝，把这次课堂笔记命名为“${marker}”。这是一次普通学习问答，不是长期用户事实。`);
  await foregroundDone();
  await until(async () => (await evaluate('window.api.memory.turns({limit:100})')).every(t => !['pending','processing'].includes(t.extractionState)), 'target real history capture settled');
  assert(!JSON.stringify(await evaluate(`window.api.memory.list({scopeType:'bot',scopeId:${JSON.stringify(peer)},status:'active'})`)).includes(marker), 'ordinary Q&A is not a permanent memory fact');
  const targetBefore = await history();
  await select(owner, 'MyBuddy');
  report.peerCalls = { recipientBotId: peer, cases: [], observedStatuses: [] };
  let pendingShot = false;
  const latest = async prompt => (await history()).messages.find(m => m.role === 'user' && m.text === prompt);
  const waitAnswer = async prompt => {
    let output;
    await until(async () => {
      const h = await history(), user = h.messages.find(m => m.role === 'user' && m.text === prompt);
      output = user && h.messages.find(m => m.role === 'assistant' && m.requestId === user.requestId);
      for (const call of output?.botCalls || []) {
        if (!report.peerCalls.observedStatuses.includes(call.status)) report.peerCalls.observedStatuses.push(call.status);
        if (!pendingShot && call.status === 'running') {
          pendingShot = true;
          const shot = await rpc('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
          fs.writeFileSync(path.join(out,'peer-calling.png'),Buffer.from(shot.data,'base64'));
        }
      }
      return output && !['queued','running','unknown'].includes(output.status);
    }, 'peer response: '+prompt.slice(0,40));
    assert.equal(output.status,'completed',output.error);
    const calls = output.botCalls || [];
    assert(calls.length > 0, 'natural request must cause actual cross-Bot dispatch');
    assert(calls.every(c => c.targetBotId === peer && c.status === 'completed' && c.replyText?.trim()), 'actual requested recipient returned a real answer');
    return output;
  };
  const cases = [
    {type:'学习记录召回',prompt:'学习搭子今天学到了很多，你从他那学习到了什么？请问它目前能够确认的学习记录。',check:t=>t.includes(marker)&&/浅拷贝/.test(t)},
    {type:'数学计算',prompt:'帮我问学习搭子：17乘23等于多少？请它自己算一下，告诉我它的答案。',check:t=>/391/.test(t)},
    {type:'语言翻译',prompt:'帮我请学习搭子把“Good morning, my friend”翻译成中文。让我看到它的回答。',check:t=>/早|上午/.test(t)&&/朋友/.test(t)},
    {type:'代码解释',prompt:'帮我问学习搭子：Python 表达式 [x*x for x in range(3)] 的结果是什么，为什么？',check:t=>/0/.test(t)&&/1/.test(t)&&/4/.test(t)},
    {type:'概念比较',prompt:'我想听学习搭子的观点：Python 元组和列表最核心的区别是什么？请替我问它，简短回答。',check:t=>/可变|不可变|修改/.test(t)},
    {type:'学习规划',prompt:'请问学习搭子，只有两天怎么复习 Python 基础？请它给一个两步计划，不实际执行任何任务。',check:t=>/第.?天|两|2|二/.test(t)},
  ];
  for (const c of cases.slice(0,4)) {
    const offset = requests.length;
    await send(c.prompt); const message = await waitAnswer(c.prompt);
    assert(c.check(message.botCalls.map(x=>x.replyText).join('\n')), c.type+' must verify recipient output, not only owner text');
    report.peerCalls.cases.push({type:c.type,requestId:message.requestId,calls:message.botCalls,modelCalls:requests.length-offset});
    if (c.type === '数学计算') {
      await evaluate(`(()=>{const e=document.querySelector('[data-call-id="${message.botCalls[0].callId}"]').closest('details');e.open=true;e.scrollIntoView({block:'center'});})()`);
      const shot = await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(out,'peer-math-reply.png'),Buffer.from(shot.data,'base64'));
    }
  }
  const offset = requests.length;
  await send(cases[4].prompt); await send(cases[5].prompt);
  for (const c of cases.slice(4)) {
    const message = await waitAnswer(c.prompt);
    assert(c.check(message.botCalls.map(x=>x.replyText).join('\n')),c.type);
    report.peerCalls.cases.push({type:c.type,requestId:message.requestId,calls:message.botCalls,concurrent:true});
  }
  report.peerCalls.concurrentModelCalls = requests.length-offset;
  assert.equal(report.peerCalls.cases.length,6);
  assert.equal(new Set(report.peerCalls.cases.map(c=>c.requestId)).size,6);
  const h = await history();
  assert.equal((await evaluate(`window.api.botWork.history({botId:${JSON.stringify(peer)}})`)).messages.length,targetBefore.messages.length,'calls do not write fake user turns into target conversation');
  assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length,0,'questions are not synthetic background Work');
  assert(report.peerCalls.observedStatuses.includes('running'),'actual calling state observed');
  await until(()=>evaluate('document.querySelectorAll(".bot-call-thread").length >= 6'),'rendered six actual exchange summaries');
  await evaluate('document.querySelectorAll(".bot-call-thread").forEach(e=>e.open=true)');
  const visible = await evaluate('document.querySelectorAll(".bot-call-thread")[0].innerText');
  assert(visible.includes('学习搭子')&&visible.includes(marker),'real recipient reply is visible in source conversation');
  const shot = await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  fs.writeFileSync(path.join(out,'peer-replies.png'),Buffer.from(shot.data,'base64'));
  await rpc('Page.reload');
  await until(()=>evaluate('Boolean(window.api?.botWork?.history && document.querySelector("#bot-draft"))'),'reloaded source conversation');
  const restored = await history();
  for (const original of h.messages.filter(m=>m.botCalls?.length))
    assert.deepEqual(restored.messages.find(m=>m.messageId===original.messageId)?.botCalls,original.botCalls,'durable exchange survives reload');
  report.checks.push('six distinct real-model recipient tasks through Electron composer, live state, original replies, concurrent request separation, read-only recipient inbox and reload durability');
};
