/** Eight real-model task types. Isolated HOME supplied by frontdoor harness.
 * No direct memory writes: all learn/correct/forget/share operations use the Bot UI.
 * The team/project/work boundaries require their own runtime fixtures; this scenario
 * deliberately does not claim to test them.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({ send, foregroundDone, until, evaluate, history, rpc, report, requests, out, botId, setBotId }) => {
  assert.equal(typeof setBotId, 'function', 'harness must change history/send Bot identity with UI selection');
  const a = botId;
  const created = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'隔离旅行助理',responsibilitySummary:'处理旅行和日常事务'})`);
  assert(created.ok, 'second Bot created through product API');
  const b = created.bot.botId;
  const markers = { a: '白桦甲731', revised: '琥珀甲842', b: '海星乙963', temporary: '临时雨伞625', public: '共享青丘517' };
  const list = (scopeType, scopeId) => evaluate(`window.api.memory.list(${JSON.stringify({ scopeType, scopeId, status: 'active' })})`);
  const text = (records) => records.map(r => `${r.title}\n${r.content}`).join('\n');
  const select = async (id, name) => {
    await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);
    setBotId(id);
    await until(() => evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent===${JSON.stringify(name)}`), `select ${name}`);
  };
  const newChat = async () => {
    const old = (await history()).conversationId;
    await evaluate('document.querySelector(".bot-new-conversation").click()');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'), 'new conversation dialog');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');
    await until(async () => { const h = await history(); return h.conversationId !== old && h.messages.length === 0; }, 'new conversation identity');
    return (await history()).conversationId;
  };
  const say = async prompt => { await send(prompt); await foregroundDone(); };
  const answer = async () => {
    const h = await history();
    const id = h.messages.filter(m => m.role === 'user').at(-1)?.requestId;
    const result = h.messages.filter(m => m.role === 'assistant' && m.requestId === id).at(-1);
    assert.equal(result?.status, 'completed');
    return result.text;
  };
  report.cases = [];
  const task = async ({ title, prompt, required = [], forbidden = [] }) => {
    const offset = requests.length;
    await say(prompt);
    const output = await answer();
    for (const value of required) assert(output.includes(value), `${title}: expected ${value} in answer`);
    for (const value of forbidden) {
      assert(!output.includes(value), `${title}: unexpected private/temporary marker in answer`);
      assert(!JSON.stringify(requests.slice(offset)).includes(value), `${title}: unexpected marker sent to model`);
    }
    const row = { title, conversationId: (await history()).conversationId, output, modelCalls: requests.length - offset };
    report.cases.push(row); console.log(JSON.stringify(row));
  };
  await say(`请长期记住我的答复格式偏好：这个 Bot 每次最终答复末尾单独写“${markers.a}”。不要分享给其他 Bot。`);
  await until(async () => text(await list('bot', a)).includes(markers.a), 'A private memory');
  await select(b, '隔离旅行助理');
  await say(`请长期记住我的答复格式偏好：这个 Bot 每次最终答复末尾单独写“${markers.b}”。不要分享给其他 Bot。`);
  await until(async () => text(await list('bot', b)).includes(markers.b), 'B private memory');
  await select(a, 'MyBuddy');
  const temporaryConversationId = (await history()).conversationId;
  await say(`只在本次对话记住取件代号“${markers.temporary}”，新对话不得继续使用，不是长期偏好。`);
  await until(async () => text(await list('conversation', temporaryConversationId)).includes(markers.temporary), 'temporary memory stored under exact conversation');
  assert(!text(await list('bot', a)).includes(markers.temporary), 'temporary instruction must not become Bot private memory');
  await task({ title: '库存计算与当前会话记忆', prompt: '17件加29件共多少件？并告诉我本次对话的取件代号。', required: ['46', markers.a, markers.temporary], forbidden: [markers.b] });
  await select(b, '隔离旅行助理'); await newChat();
  await task({ title: '行程建议与跨Bot隔离', prompt: '给出三条不依赖实时信息的半日散步建议。', required: [markers.b], forbidden: [markers.a, markers.temporary] });
  await select(a, 'MyBuddy'); await newChat();
  await task({ title: '会议议程与新对话边界', prompt: '列一个15分钟例会的三段议程。如果记得取件代号也告诉我，没有记录就说不知道。', required: [markers.a], forbidden: [markers.temporary, markers.b] });
  await select(b, '隔离旅行助理'); await newChat();
  await task({ title: '客服文字改写', prompt: '把“我们会于明天回复您的问题”改写得简洁友好。', required: [markers.b], forbidden: [markers.a, markers.temporary] });
  await select(a, 'MyBuddy');
  await say(`更正此 Bot 的长期答复末尾标记：改为“${markers.revised}”，旧标记不再使用。`);
  await until(async () => text(await list('bot', a)).includes(markers.revised), 'private correction persisted');
  assert(text(await list('bot', b)).includes(markers.b), 'correction leaves B intact');
  await newChat();
  await task({ title: '单位换算与记忆更正', prompt: '2.5公里等于多少米？请写出换算关系。', required: ['2500', markers.revised], forbidden: [markers.b, markers.temporary] });
  await select(b, '隔离旅行助理'); await newChat();
  await task({ title: '出门清单与独立偏好', prompt: '列出门前的三项物品检查清单。', required: [markers.b], forbidden: [markers.revised, markers.temporary] });
  await select(a, 'MyBuddy');
  await say(`明确共享给所有 Bot 的公共事实：我们的测试项目代号是“${markers.public}”。请保存为公共记忆，不要把我的个人答复格式共享出去。`);
  await until(async () => (await list('global')).some(r => `${r.title}\n${r.content}`.includes(markers.public) && r.metadata?.publicShared === true), 'explicit public opt-in persisted');
  await select(b, '隔离旅行助理'); await newChat();
  await task({ title: '装箱表格与显式公共记忆', prompt: '12本书平均装入3个箱子，请用两列表格写箱号和数量，并注明我们公共记忆中的测试项目代号。', required: ['4', markers.public, markers.b], forbidden: [markers.revised, markers.temporary] });
  await select(a, 'MyBuddy');
  await say('忘记并删除本 Bot 关于最终答复末尾标记的长期记忆。保留公共项目代号，不改其他 Bot 的记忆。');
  await until(async () => !text(await list('bot', a)).includes(markers.revised), 'A forgotten');
  assert(text(await list('bot', b)).includes(markers.b), 'forget leaves B intact');
  await newChat();
  await task({ title: '短句校对与精确遗忘', prompt: '把“明天上午十点开会请准时参加”加上合适标点，最后另列公共测试项目代号。', required: [markers.public], forbidden: [markers.a, markers.revised, markers.b, markers.temporary] });
  assert.equal(report.cases.length, 8);
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'memory-scopes-eight-types.png'), Buffer.from(shot.data, 'base64'));
  report.checks.push('eight real-model task types; two private Bot memories; temporary conversation memory expires from projection in a new conversation; private memory survives new conversation; explicit public opt-in; private correction/forget does not affect other Bot or public fact; request-wire isolation');
  report.unverified = [...(report.unverified || []), 'team/project/work scope runtime boundaries are not exercised by this scenario', 'physical desktop input and crash injection are not exercised'];
};
