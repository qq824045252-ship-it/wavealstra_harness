/** Real-model acceptance through the isolated Bot composer. All fixtures are synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async ({ send, foregroundDone, until, evaluate, history, report, requests, out, home, setBotId }) => {
  let currentBot;
  report.cases = [];
  const atoms = () => evaluate(`window.api.memory.list(${JSON.stringify({ scopeType: 'bot', scopeId: currentBot, status: 'active' })})`);
  const settle = () => until(async () => (await evaluate('window.api.memory.turns({limit:100})')).every(t => !['pending','processing'].includes(t.extractionState)), 'memory extraction settled');
  const say = async text => {
    await send(text); await foregroundDone(); await settle();
    const h = await history();
    const requestId = h.messages.filter(m => m.role === 'user').at(-1)?.requestId;
    const answer = h.messages.find(m => m.role === 'assistant' && m.requestId === requestId);
    assert.equal(answer?.status, 'completed');
    return answer.text;
  };
  const newBot = async name => {
    const made = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:${JSON.stringify(name)},responsibilitySummary:'隔离的学习连续性验收，只处理用户本次请求'})`);
    assert(made.ok, 'create isolated fixture Bot'); currentBot = made.bot.botId; setBotId(currentBot);
    await until(() => evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})`), 'fixture Bot visible');
    await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);
    await until(() => evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent===${JSON.stringify(name)}`), 'fixture Bot selected');
  };
  const newChat = async () => {
    const old = (await history()).conversationId;
    await evaluate('document.querySelector(".bot-new-conversation").click()');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'), 'new conversation dialog');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');
    await until(async () => { const h=await history(); return h.conversationId!==old && h.messages.length===0; }, 'new conversation');
  };
  const probe = async (prompt, required=[], forbidden=[], wireForbidden=[]) => {
    const from=requests.length, answer=await say(prompt);
    for(const text of required) assert(answer.includes(text), `answer omitted ${text}: ${answer}`);
    for(const text of forbidden) assert(!answer.includes(text), `answer resurrected ${text}: ${answer}`);
    const wire=JSON.stringify(requests.slice(from));
    for(const text of wireForbidden) assert(!wire.includes(text), `provider received forbidden historical source ${text}`);
    return {answer, modelCalls:requests.length-from, conversationId:(await history()).conversationId};
  };
  /** Issue #28 acceptance: >1000 synthetic pairs across interleaved conversations, none
   * promoted into L1, with one older decision that the real model turn must retrieve.
   * Written straight into the isolated profile DB; memory_turns are marked skipped so
   * extraction never turns them into durable facts. */
  const seedLongHistory = ({ botId }) => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(home, '.mybuddy', 'app.db'), { fileMustExist: true });
    db.pragma('busy_timeout = 8000');
    const now = Date.now(), pairs = 1100, conversations = 12;
    const filler = '普通排期与会议记录，和本次问题无关。';
    const buriedUser = '长航项目418 的旧方案：灰度回滚演练先用 NSH 的 MTLS 双通道演练，再由值班同学手动切换。';
    const buriedAnswer = '长航项目418 方案记录编号 B-8412：灰度回滚演练使用 NSH MTLS 双通道，先演练再切换。';
    const decoyUser = '松岛项目907 的结论：用延迟队列削峰。';
    const decoyAnswer = '松岛项目907 结论保持不变。';
    const insertConversation = db.prepare("INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?)");
    const insertMessage = db.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'completed',?,?)`);
    const insertReceipt = db.prepare(`INSERT INTO bot_send_receipts(user_id,bot_id,request_id,payload_hash,conversation_id,user_message_id,assistant_message_id)
      VALUES (?,?,?,?,?,?,?)`);
    const insertTurn = db.prepare(`INSERT INTO memory_turns(id,task_id,user_message_id,assistant_message_id,user_text,assistant_text,content_hash,captured_at,extraction_state)
      VALUES (?,?,?,?,?,?,?,?,'skipped')`);
    let seeded = 0;
    db.transaction(() => {
      for (let c = 0; c < conversations; c++) insertConversation.run(`hist-c${c}`, botId, 'user-local-primary', now, now, now);
      for (let i = 0; i < pairs; i++) {
        const conversation = `hist-c${i % conversations}`;
        const userText = i === 0 ? buriedUser : i === 1 ? decoyUser : `历史讨论 ${i}：${filler}`;
        const assistantText = i === 0 ? buriedAnswer : i === 1 ? decoyAnswer : `历史回答 ${i}：${filler}`;
        const at = now - (pairs - i) * 60_000;
        const userMessageId = `hist-u${i}`, assistantMessageId = `hist-a${i}`, requestId = `hist-r${i}`;
        insertMessage.run(userMessageId, conversation, botId, requestId, 'user', userText, at, at);
        insertMessage.run(assistantMessageId, conversation, botId, requestId, 'assistant', assistantText, at + 1, at + 1);
        insertReceipt.run('user-local-primary', botId, requestId, `hash-${i}`, conversation, userMessageId, assistantMessageId);
        insertTurn.run(`hist-t${i}`, conversation, userMessageId, assistantMessageId, '', '', `hist-hash-${i}`, at);
        seeded++;
      }
    })();
    db.close();
    return { pairs: seeded, conversations, buriedUser, buriedAnswer, decoyUser };
  };

  const cases = [
    ['framework learning continuity', async () => {
      await say('用两句话解释NSH（Native Shell）和GPUI Kit的分工，给这次课堂笔记取名“星桥课堂783”。这是一次解释练习，不是长期用户事实。');
      assert(!JSON.stringify(await atoms()).includes('星桥课堂783'), 'research answer must not be promoted to stable user memory');
      await newChat();
      return probe('我要开始使用nsh和gpui kit。先复述我们之前这两个框架课堂笔记的名字与NSH的全称，不要重查网页。', ['星桥课堂783','Native Shell']);
    }],
    ['inventory arithmetic continuity', async () => {
      await say('做一次石榴库存472演算：17箱加29箱是多少箱？给出算式，不存为长期用户事实。');
      await newChat();
      return probe('石榴库存472上次演算的结果是多少？请复述算式，不要假设没有给过数量。', ['46']);
    }],
    ['creative writing continuity', async () => {
      await say('写一段不超过60字的游星592图书馆微小说，故事标题叫“银色门铃”。这是一次创作任务。');
      await newChat();
      return probe('游星592图书馆微小说之前叫什么标题？请只复述标题，不重新创作。', ['银色门铃']);
    }],
    ['configuration correction', async () => {
      await say('请长期记住：蒲公英项目814的默认开发端口是6173。');
      await until(async()=>JSON.stringify(await atoms()).includes('6173'),'initial port saved');
      await say('更正蒲公英项目814的默认开发端口：改为6284，旧的6173不再使用。请更新长期记忆。');
      await until(async()=>JSON.stringify(await atoms()).includes('6284'),'corrected port saved');
      await newChat();
      return probe('按蒲公英项目814当前默认端口写一行JavaScript常量 PORT，只给当前值。', ['6284'], ['6173']);
    }],
    ['forgetting with request-wire verification', async () => {
      await say('请长期记住：夜航项目936的测试代号是紫鲸273。');
      await until(async()=>JSON.stringify(await atoms()).includes('紫鲸273'),'code saved');
      await say('忘记并删除夜航项目936测试代号的长期记忆，后续不要从旧对话恢复它。');
      await until(async()=>!JSON.stringify(await atoms()).includes('紫鲸273'),'code forgotten');
      await newChat();
      return probe('夜航项目936的测试代号是什么？无记录就说明不知道，不能猜。', [], ['紫鲸273'], ['紫鲸273']);
    }],
    ['cross-Bot study-plan isolation', async () => {
      await say('为木棉课程725写一份三步学习计划，计划标题必须是“月砂学程”。这是一次计划草稿。');
      await newBot('隔离历史接收者725');
      return probe('木棉课程725之前的学习计划叫什么？若没有记录，请直说不知道。', [], ['月砂学程'], ['月砂学程']);
    }],
    ['conversation-only outline boundary', async () => {
      const variants=[];
      for(const [index,wording,marker] of [[1,'仅本会话有效','风铃638'],[2,'只在这个对话中使用','晚星649'],[3,'仅此会话有效','清湖650']]) {
        try {
          await newBot(`会话边界专项${index}`);
          await say(`${wording}：写作练习的主题代号为“${marker}”。按这个代号写三条小说大纲。`);
          assert(!JSON.stringify(await atoms()).includes(marker),'conversation-only marker cannot become stable Bot memory');
          await newChat();
          variants.push({wording,status:'passed',...await probe('之前写作练习的主题代号是什么？没有可用记录就说明不知道。', [], [marker], [marker])});
        } catch(error) { variants.push({wording,status:'failed',error:String(error.stack||error)}); }
      }
      report.temporaryScopeVariants=variants;
      assert.equal(variants.filter(v=>v.status==='failed').length,0,JSON.stringify(variants));
      return {variants};
    }],
    ['unrelated translation relevance', async () => {
      await say('写一份黄蜡笔646美术活动的两条安排，使用标题“落叶画室”。');
      await newChat();
      return probe('把“The meeting starts at ten tomorrow.”翻译成简短中文。', ['明天'], ['落叶画室','黄蜡笔646'], ['落叶画室','黄蜡笔646']);
    }],
    ['long synthetic history beyond the old recency window', async () => {
      const seeded = seedLongHistory({ botId: currentBot });
      const from = requests.length;
      const answer = await say('继续长航项目418的灰度回滚演练：之前定的旧方案是什么？只复述旧方案和出处，不要重新设计。');
      assert(answer.includes('NSH') && answer.includes('MTLS'), `answer must quote the old decision: ${answer}`);
      assert(!answer.includes('松岛项目907'), `unrelated project must not leak: ${answer}`);
      const wire = JSON.stringify(requests.slice(from));
      assert(wire.includes('B-8412'), 'the buried original answer was actually injected into the provider request');
      assert(!wire.includes('松岛项目907'), 'a different project was not injected');
      return {answer, seeded: {pairs: seeded.pairs, conversations: seeded.conversations}, modelCalls: requests.length - from,
        conversationId: (await history()).conversationId, wireProvenance: 'B-8412'};
    }],
  ];
  for(let index=0;index<cases.length;index++) {
    const [title, run]=cases[index], started=Date.now();
    try {
      await newBot(`连续性验收${index+1}`);
      const result=await run();
      report.cases.push({title,status:'passed',elapsedMs:Date.now()-started,...result});
    } catch(error) {
      report.cases.push({title,status:'failed',elapsedMs:Date.now()-started,error:String(error.stack||error)});
    }
    fs.writeFileSync(path.join(out,'cases-progress.json'),JSON.stringify(report.cases,null,2));
    console.log(JSON.stringify(report.cases.at(-1)));
  }
  assert.equal(report.cases.length,9,'all nine distinct real-model task types attempted');
  report.checks.push('nine distinct real-model task types through isolated Bot composer; source/answer continuity, correction, forgetting, Bot isolation, conversation-only scope, relevance, 1100-pair un-extracted history beyond the old recency window; provider-wire assertions');
  const failures=report.cases.filter(row=>row.status!=='passed');
  assert.equal(failures.length,0,failures.map(row=>row.title).join(', '));
};
