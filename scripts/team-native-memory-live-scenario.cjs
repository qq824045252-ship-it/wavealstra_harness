/** Real UI + provider transport + native team executors. No DB/memory injection.
 * Runner must enable memory and pass mutable setBotId/setTeamId identities.
 * Does not test subagents, desktop control or crash injection.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async ({ send, foregroundDone, until, evaluate, history, rpc, report, requests, out, botId, setBotId, setTeamId }) => {
  assert.equal(typeof setBotId, 'function'); assert.equal(typeof setTeamId, 'function');
  const owner = botId;
  const members = [];
  const marker = { owner: '私有山雀741', first: '私有白鹭852', second: '私有翠鸟963', a: '团队银杉274', b: '团队红枫385', public: '公共云桥496' };
  const say = async text => { await send(text); await foregroundDone(); };
  const atoms = (scopeType, scopeId) => evaluate(`window.api.memory.list(${JSON.stringify({ scopeType, scopeId, status: 'active' })})`);
  const contains = (records, value) => records.some(record => `${record.title}\n${record.content}`.includes(value));
  const select = async (name, id, teamId) => {
    await until(() => evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})`), `sidebar ${name}`);
    await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);
    setBotId(id); setTeamId(teamId);
    await until(() => evaluate(`document.querySelector('.bot-heading h1')?.textContent===${JSON.stringify(name)}`), `open ${name}`);
  };
  const newChat = async () => {
    const old = (await history()).conversationId;
    await evaluate('document.querySelector(".bot-new-conversation").click()');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'), 'new chat dialog');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');
    await until(async () => { const h = await history(); return h.conversationId !== old && h.messages.length === 0; }, 'fresh team conversation');
  };
  await say(`长期记住这个 Bot 的私人回复格式：每次最终答复末尾单独写“${marker.owner}”，只属于本 Bot。`);
  await until(async () => contains(await atoms('bot', owner), marker.owner), 'owner private memory persisted');
  for (const [name, value] of [['原生验收分析员', marker.first], ['原生验收复核员', marker.second]]) {
    const result = await evaluate(`window.api.botWork.createBot(${JSON.stringify({ requestId: require('node:crypto').randomUUID(), displayName: name, responsibilitySummary: '根据团队委托独立分析核验，不访问其他身份私有信息' })})`);
    assert(result.ok, JSON.stringify(result)); members.push({ id: result.bot.botId, name });
    await select(name, result.bot.botId);
    await say(`长期记住这个 Bot 的私人回复格式：每次最终答复末尾单独写“${value}”，只属于本 Bot。`);
    await until(async () => contains(await atoms('bot', result.bot.botId), value), 'member private memory persisted');
  }
  const createTeam = async name => {
    await select('MyBuddy', owner);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='新建团队').click()`);
    await until(() => evaluate(`!!document.querySelector('dialog[open] input[maxlength="120"]')`), 'team creation form');
    await evaluate(`document.querySelector('dialog[open] input[maxlength="120"]').focus()`); await rpc('Input.insertText', { text: name });
    for (const [index, member] of members.entries()) {
      await evaluate(`[...document.querySelectorAll('dialog[open] .bot-team-member-choice')].find(e=>e.querySelector('label')?.textContent===${JSON.stringify(member.name)}).querySelector('input[type=checkbox]').click()`);
      await evaluate(`document.querySelector(${JSON.stringify(`dialog[open] input[aria-label="${member.name}的职责"]`)}).focus()`);
      await rpc('Input.insertText', { text: index === 0
        ? '独立完成本次任务的分析和结果，基于团队记忆给出团队验收代码及公共项目代号，不猜测未查到的信息。'
        : '独立复核本次任务的输入和结果，给出可检查的核验结论，基于团队记忆给出团队验收代码及公共项目代号，不依赖私人回复偏好。' });
    }
    await evaluate(`document.querySelector('dialog[open] button[type=submit]').click()`);
    await until(() => evaluate(`document.querySelector('.bot-heading h1')?.textContent===${JSON.stringify(name)} && !document.querySelector('dialog[open]')`), 'team UI created');
    const result = await evaluate(`window.api.botWork.teamControl({kind:'list_templates'})`);
    const team = result.templates.find(t => t.name === name); assert(team);
    assert.equal(team.ownerBotId, owner);
    assert.deepEqual(team.members.map(m => m.botId).sort(), members.map(m => m.id).sort(), 'two distinct members in UI template');
    setBotId(owner); setTeamId(team.templateId);
    return { id: team.templateId, name };
  };
  const a = await createTeam('原生记忆银杉团队');
  await say(`请长期记住本团队专属验收代码为“${marker.a}”。每位成员和负责人在本团队工作结果中都要标注该代码，只属于本团队。`);
  await until(async () => contains(await atoms('team', a.id), marker.a), 'team A persisted naturally');
  const b = await createTeam('原生记忆红枫团队');
  await say(`请长期记住本团队专属验收代码为“${marker.b}”。每位成员和负责人在本团队工作结果中都要标注该代码，只属于本团队。`);
  await until(async () => contains(await atoms('team', b.id), marker.b), 'team B persisted naturally');
  await select('MyBuddy', owner);
  await say(`显式共享给所有 Bot 和团队：公共测试项目代号为“${marker.public}”。请保存为公共记忆，私人回复格式仍只留在个人 Bot。`);
  await until(async () => (await atoms('global')).some(r => r.metadata?.publicShared === true && `${r.title}\n${r.content}`.includes(marker.public)), 'public opt-in persisted');
  const cases = [
    { title: '库存算术', task: '库存A有17件，B有29件，求总数，写出算式。', verify: text => assert(/46/.test(text), 'inventory total is 46') },
    { title: '会议议程', task: '设计15分钟例会：固定使用进展2分钟、问题8分钟、行动5分钟三段，逐段列出并核对总时长。', verify: text => { for (const n of ['2', '8', '5', '15']) assert(text.includes(n), 'agenda includes all durations'); for (const label of ['进展', '问题', '行动']) assert(text.includes(label)); } },
    { title: '客服改写', task: '把“我们已经收到您的来信并将在明天回复”改写成一句简洁友好的客服答复，必须保留已收到和明天回复两个事实，不添加新的承诺。', verify: text => assert(/收到/.test(text) && /明天/.test(text) && /回复/.test(text), 'reply preserves stated facts') },
    { title: '单位换算', task: '将2.5公里换算成米，写出换算关系。', verify: text => assert(/2500|2,500/.test(text), 'conversion is 2500 metres') },
    { title: '记录提取', task: '从原文“林海：已提交；周宁：待补充；陈露：已提交”提取已提交姓名，只列这两人，再给出人数，不把待补充者列为已提交。', verify: text => assert(text.includes('林海') && text.includes('陈露') && /2|两/.test(text), 'both submitted names and count retained') },
    { title: '数字排序', task: '将数字8、3、11、1从小到大排列，用逗号分隔。', verify: text => assert(/1\s*[,，、]\s*3\s*[,，、]\s*8\s*[,，、]\s*11/.test(text), 'ascending order is correct') },
  ];
  report.cases = [];
  for (const [index, test] of cases.entries()) {
    const team = index % 2 ? b : a, ownMarker = index % 2 ? marker.b : marker.a, otherMarker = index % 2 ? marker.a : marker.b;
    await select(team.name, owner, team.id); await newChat();
    const before = new Set((await evaluate('window.api.botWork.listWorks(true)')).map(w => w.workId));
    const offset = requests.length;
    await say(`请交给本团队一次性后台委托，标题“团队原生记忆${index + 1}-${test.title}”：${test.task}按本团队模板让分析员和复核员都实际执行，负责人整合结果。每位成员和负责人要从记忆中写出本团队验收代码及公共测试项目代号；没有记录如实说明，不能猜。只交付文字，不联网，不读写文件，不创建子代理，不需要我人工验收。`);
    await until(async () => (await evaluate('window.api.botWork.listWorks(true)')).some(w => !before.has(w.workId)), 'native team Work created');
    const created = (await evaluate('window.api.botWork.listWorks(true)')).filter(w => !before.has(w.workId));
    assert.equal(created.length, 1, 'exactly one team Work, not duplicate ordinary work');
    const id = created[0].workId;
    await until(async () => (await evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`)).lifecycle === 'closed', 'all members and owner settled');
    const work = await evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
    assert.equal(work.team?.teamId, team.id); assert.equal(work.closureConclusion, 'succeeded');
    const executions = work.team.executions;
    const workers = executions.filter(e => e.role === 'member'), leaders = executions.filter(e => e.role === 'owner_summary');
    assert.equal(workers.length, 2); assert.equal(leaders.length, 1);
    assert.deepEqual(workers.map(e => e.botId).sort(), members.map(m => m.id).sort());
    assert.equal(new Set(executions.map(e => e.taskId)).size, 3, 'two members and owner have distinct native tasks');
    const diagnostics = await evaluate(`window.api.botWork.executionDiagnostics({kind:'work',workId:${JSON.stringify(id)}})`);
    for (const execution of executions) {
      assert(['completed', 'recovered'].includes(execution.status), `native execution ${execution.botId}: ${execution.status}`);
      const group = diagnostics.groups.find(g => g.id === execution.taskId);
      assert(group?.value?.requests?.length, `actual native model diagnostics for ${execution.taskId}`);
      assert(group.value.requests.every(r => r.taskId === execution.taskId), 'diagnostics belong to exact member/owner');
      const result = execution.resultSummary || '';
      assert(result.includes(ownMarker), `${execution.botId}: own team memory returned`);
      assert(result.includes(marker.public), `${execution.botId}: public memory returned`);
      for (const forbidden of [marker.owner, marker.first, marker.second, otherMarker]) assert(!result.includes(forbidden), 'private or other-team memory absent from member output');
    }
    const finalOutput = leaders[0].resultSummary || '';
    test.verify(finalOutput);
    await until(async () => (await history()).messages.some(m => m.workFeedback?.kind === 'result' && m.workIds?.includes(id)), 'owner result delivered to original team chat');
    const wire = JSON.stringify(requests.slice(offset));
    for (const forbidden of [marker.owner, marker.first, marker.second, otherMarker]) assert(!wire.includes(forbidden), 'private/other-team marker absent from actual provider request wire');
    const native = requests.slice(offset).filter(r => r.messages?.some(m => m.role === 'user' && JSON.stringify(m.content).includes(id)));
    assert(native.length >= 3, 'native Work provider requests captured');
    const evidence = native.flatMap(r => r.messages || []).map(m => JSON.stringify(m.content)).filter(content => content.includes('[L1 ')).join('\n');
    assert(evidence.includes(ownMarker), 'native L1 includes current team memory, not just quoted task text');
    assert(evidence.includes(marker.public), 'native L1 includes explicit public memory');
    await until(async () => (await atoms('work', id)).some(m => m.metadata?.captureSource === `work-summary:${id}` && m.content.includes('状态：closed')), 'closed Work memory event persisted');
    const workAtoms = await atoms('work', id);
    const summary = workAtoms.find(m => m.metadata?.captureSource === `work-summary:${id}`);
    assert(summary && summary.scopes.every(scope => scope.scopeType === 'work' && scope.scopeId === id), 'automatic Work summary belongs only to its Work');
    for (const [scopeType, scopeId] of [['team', team.id], ['bot', owner], ...members.map(m => ['bot', m.id])]) {
      assert(!(await atoms(scopeType, scopeId)).some(m => m.metadata?.captureSource === `work-summary:${id}`), 'Work event not copied to team/member private memory');
    }
    const row = { title: test.title, workId: id, teamId: team.id, nativeCalls: native.length,
      executions: executions.map(e => ({ botId: e.botId, taskId: e.taskId, status: e.status, resultSummary: e.resultSummary })), finalOutput, summaryMemoryId: summary.id };
    report.cases.push(row); console.log(JSON.stringify(row));
  }
  assert.equal(report.cases.length, 6);
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'team-native-memory-six-types.png'), Buffer.from(shot.data, 'base64'));
  report.checks.push('six task types; two UI-created teams; two native Bot members plus owner per Work; team/public memory in native L1 and all role results; private/other-team markers absent from provider wire; Work summary stays Work-scoped; result delivered to origin team');
  report.unverified = [...(report.unverified || []), 'temporary subagents, crash injection and physical desktop actions not exercised'];
};
