/** Real-model acceptance through the isolated Bot composer. All fixtures are synthetic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async ({ send, foregroundDone, until, evaluate, history, report, requests, out, setBotId }) => {
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
  assert.equal(report.cases.length,8,'all eight distinct real-model task types attempted');
  report.checks.push('eight distinct real-model task types through isolated Bot composer; source/answer continuity, correction, forgetting, Bot isolation, conversation-only scope, relevance; provider-wire assertions');
  const failures=report.cases.filter(row=>row.status!=='passed');
  assert.equal(failures.length,0,failures.map(row=>row.title).join(', '));
};
