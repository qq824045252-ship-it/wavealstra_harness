/** Real model + real UI; isolated HOME is owned by the frontdoor harness.
 * Required mutable runner identities: setBotId and setTeamId (undefined clears team).
 * Reads use product APIs; no SQL injection or direct memory creation.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({ send, foregroundDone, until, evaluate, history, rpc, report, requests, out, botId, setBotId, setTeamId }) => {
  assert.equal(typeof setBotId, 'function'); assert.equal(typeof setTeamId, 'function');
  const owner = botId;
  const markers = { owner: '私人北辰184', member: '私人南星295', a: '团队青岚316', b: '团队海棠427', public: '共享松石538' };
  const member = await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'团队记忆验收成员',responsibilitySummary:'核验简单事实与日常计算'})`);
  assert(member.ok, JSON.stringify(member));
  const say = async prompt => { await send(prompt); await foregroundDone(); };
  const list = (scopeType, scopeId) => evaluate(`window.api.memory.list(${JSON.stringify({ scopeType, scopeId, status: 'active' })})`);
  const text = records => records.map(r => `${r.title}\n${r.content}`).join('\n');
  const select = async (name, id, team) => {
    await until(() => evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})`), `sidebar ${name}`);
    await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);
    setBotId(id); setTeamId(team);
    await until(() => evaluate(`document.querySelector('.bot-heading h1')?.textContent===${JSON.stringify(name)}`), `selected ${name}`);
  };
  const newChat = async () => {
    const old = (await history()).conversationId;
    await evaluate('document.querySelector(".bot-new-conversation").click()');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'), 'team new chat dialog');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');
    await until(async () => { const h = await history(); return h.conversationId !== old && h.messages.length === 0; }, 'new conversation has distinct identity');
  };
  const createTeam = async name => {
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='新建团队').click()`);
    await until(() => evaluate(`!!document.querySelector('dialog[open] input[maxlength="120"]')`), 'new team form');
    await evaluate(`document.querySelector('dialog[open] input[maxlength="120"]').focus()`); await rpc('Input.insertText', { text: name });
    await evaluate(`document.querySelector('dialog[open] input[type=checkbox]').click()`);
    await evaluate(`document.querySelector('dialog[open] input[placeholder="这个成员负责什么"]').focus()`);
    await rpc('Input.insertText', { text: '核验计算和日常事实；不访问个人记忆' });
    await evaluate(`document.querySelector('dialog[open] button[type=submit]').click()`);
    await until(() => evaluate(`document.querySelector('.bot-heading h1')?.textContent===${JSON.stringify(name)} && !document.querySelector('dialog[open]')`), 'team created through UI');
    const result = await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`);
    const team = result.templates.find(t => t.name === name); assert(team, 'saved team template');
    assert.equal(team.ownerBotId, owner, 'team leader is fixture owner');
    assert(team.members.some(m => m.botId === member.bot.botId), 'fixture member actually belongs to team');
    setBotId(owner); setTeamId(team.templateId);
    assert.equal((await history()).messages.length, 0, 'team starts without personal history');
    return team.templateId;
  };
  await say(`长期记住：这个 Bot 的最终答复末尾单独写“${markers.owner}”，仅本 Bot，不共享。`);
  await until(async () => text(await list('bot', owner)).includes(markers.owner), 'owner private persisted');
  await select('团队记忆验收成员', member.bot.botId);
  await say(`长期记住：这个 Bot 的最终答复末尾单独写“${markers.member}”，仅本 Bot，不共享。`);
  await until(async () => text(await list('bot', member.bot.botId)).includes(markers.member), 'member private persisted');
  await select('MyBuddy', owner);
  const a = await createTeam('记忆团队青岚');
  await say(`请长期记住本团队的回复格式：最终答复末尾单独写“${markers.a}”。只属于本团队，不共享其他团队或个人 Bot。`);
  await until(async () => text(await list('team', a)).includes(markers.a), 'team A scoped memory');
  await select('MyBuddy', owner);
  const b = await createTeam('记忆团队海棠');
  await say(`请长期记住本团队的回复格式：最终答复末尾单独写“${markers.b}”。只属于本团队，不共享其他团队或个人 Bot。`);
  await until(async () => text(await list('team', b)).includes(markers.b), 'team B scoped memory');
  assert(!text(await list('bot', owner)).includes(markers.a), 'team memory is not copied to technical owner');
  await select('MyBuddy', owner);
  await say(`明确让所有 Bot 和团队共享一条公共事实：测试项目代号为“${markers.public}”。请保存到公共记忆，个人回复格式不共享。`);
  await until(async () => (await list('global')).some(r => r.metadata?.publicShared === true && `${r.title}\n${r.content}`.includes(markers.public)), 'explicit public memory');
  report.cases = [];
  const runTask = async (team, title, prompt, required = []) => {
    const id = team === 'a' ? a : b, name = team === 'a' ? '记忆团队青岚' : '记忆团队海棠';
    const own = markers[team], other = team === 'a' ? markers.b : markers.a;
    await select(name, owner, id); await newChat();
    const offset = requests.length;
    await say(prompt);
    const h = await history(), requestId = h.messages.filter(m => m.role === 'user').at(-1)?.requestId;
    const answer = h.messages.filter(m => m.role === 'assistant' && m.requestId === requestId).at(-1);
    assert.equal(answer?.status, 'completed');
    for (const marker of [own, ...required]) assert(answer.text.includes(marker), `${title}: missing ${marker}`);
    for (const marker of [markers.owner, markers.member, other]) {
      assert(!answer.text.includes(marker), `${title}: private/other-team reply leak`);
      assert(!JSON.stringify(requests.slice(offset)).includes(marker), `${title}: private/other-team request-wire leak`);
    }
    const row = { title, teamId: id, conversationId: h.conversationId, output: answer.text, modelCalls: requests.length - offset };
    report.cases.push(row); console.log(JSON.stringify(row));
  };
  await runTask('a', '库存算术', '17件加29件，共多少件？直接回答，不创建后台任务。', ['46']);
  await runTask('b', '半日行程', '不查实时信息，给三条半日公园散步建议。直接回答。');
  await runTask('a', '会议议程', '列一个15分钟例会的三段议程。直接回答。');
  await runTask('b', '客服改写', '把“我们会于明天回复您的问题”改写得简洁友好。');
  await runTask('a', '单位换算', '2.5公里等于多少米？写出换算关系。', ['2500']);
  await runTask('b', '出门清单', '给出出门前三项物品检查清单。');
  await runTask('a', '装箱表格与共享事实', '12本书均分3箱，用表格列箱号与数量，并写出公共记忆中的测试项目代号。', ['4', markers.public]);
  await runTask('b', '标点校对与共享事实', '给“明天上午十点开会请准时参加”加标点，并写出公共记忆中的测试项目代号。', [markers.public]);
  assert.equal(report.cases.length, 8);
  assert.equal(new Set(report.cases.map(r => r.conversationId)).size, 8, 'all task checks use distinct team conversations');
  assert(text(await list('bot', owner)).includes(markers.owner));
  assert(text(await list('bot', member.bot.botId)).includes(markers.member));
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'team-memory-eight-types.png'), Buffer.from(shot.data, 'base64'));
  report.checks.push('eight real-model task types across two UI-created teams and eight new conversations; team memory persists; owner/member personal markers and other-team memory absent from model wire; explicit public fact available to both teams');
  report.unverified = [...(report.unverified || []), 'team background Work/member execution and crash recovery not exercised by this frontend scenario'];
};
