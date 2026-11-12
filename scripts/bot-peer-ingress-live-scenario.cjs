/** Six real online-model cases through isolated pnpm dev and the visible composer. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

exports.run = async ({ send, until, evaluate, history, rpc, report, requests, out, home, modelKey, targetModelKey, botId }) => {
  const api = (method, input) => evaluate(`window.api.botWork.${method}(${JSON.stringify(input)})`);
  const seed = crypto.randomBytes(4).toString('hex'), aCwd = path.join(home, 'source-43'), bCwd = path.join(home, 'recipient-43');
  fs.mkdirSync(aCwd); fs.mkdirSync(bCwd);
  const target = await api('createBot', { requestId: crypto.randomUUID(), displayName: `接收助理${seed}`,
    responsibilitySummary: '收到协作时由你的正常前台自主理解。简单问答直接答复；多步文件或代码操作才创建自己的 Work。保留原用户约束，不能把发送 Bot 建议当用户原话。同一协作继续使用原 Work。' });
  assert(target.ok); const b = target.bot.botId;
  for (const [id, cwd, model] of [[botId, aCwd, modelKey], [b, bCwd, targetModelKey]]) {
    const old = (await api('getSettings', id)).settings;
    const saved = await api('saveSettings', { botId: id, expectedRevision: old.revision, workspacePath: cwd, modelId: model,
      expertId: '', skillIds: [], mcpIds: [], connectorIds: [] }); assert(saved.ok, JSON.stringify(saved));
  }
  fs.writeFileSync(path.join(bCwd, 'stock.csv'), 'item,quantity,price\nCedar,3,17\nBirch,5,23\n');
  fs.writeFileSync(path.join(bCwd, 'average.cjs'), 'exports.average = values => values.reduce((a,b)=>a+b,0) / values.length;\n');
  fs.writeFileSync(path.join(bCwd, 'incident.txt'), `Ticket: INC-${seed}\nCustomer: Lin\nSeverity: P2\nAffected users: 17\nSummary: delayed invoice export\n`);
  report.issue43 = { seed, a: botId, b, aCwd, bCwd, cases: [] };
  const persist = () => fs.writeFileSync(path.join(out, 'issue43-progress.json'), JSON.stringify(report.issue43, null, 2));
  const journal = id => api('collaborationHistory', { botId, collaborationId: id, limit: 100 });
  const poll = async (check, label, ms = 300000) => {
    const end = Date.now() + ms;
    while (!await check()) { if (Date.now() > end) throw Error(`timeout ${label}`); await new Promise(resolve => setTimeout(resolve, 250)); }
  };
  const cases = [
    { name: 'arithmetic', goal: '问它 19×23 等于多少，只需它直接回答，不需要文件或长期任务。', answer: /437/, direct: true },
    { name: 'translation', goal: '请它把“The shipment has been dispatched.”翻译为自然中文，只需一句直接答复，不需要文件或长期任务。', answer: /货|发出|发运|发货/, direct: true },
    { name: 'csv', goal: `请它读取它工作目录里的 stock.csv，逐项核算金额并合计，写入它自己目录的 stock-result.json，必须回读核验。JSON 至少有 total 字段。`, file: 'stock-result.json', check: value => assert.equal(JSON.parse(value).total, 166) },
    { name: 'code', goal: `请它修复它工作目录的 average.cjs，使 average([]) 返回 0，非空数组仍正确；实际运行 node 验证空数组和[2,4]，将核验记录写到 code-check.txt 并回读。`, file: 'code-check.txt', check: () => {
      const code = fs.readFileSync(path.join(bCwd, 'average.cjs'), 'utf8');
      const module = { exports: {} }; new Function('module', 'exports', code)(module, module.exports);
      assert.equal(module.exports.average([]), 0); assert.equal(module.exports.average([2,4]), 3);
    } },
    { name: 'structured-extraction', goal: `请它读取自己目录里的 incident.txt，提取 ticket、customer、severity、affectedUsers 到 incident.json，回读核对。`, file: 'incident.json', check: value => {
      const data = JSON.parse(value); assert.equal(data.customer, 'Lin'); assert.equal(data.affectedUsers, 17); assert.equal(data.ticket, `INC-${seed}`);
    } },
    { name: 'offline-html', goal: `请它在自己的工作目录创建适合8岁儿童的离线 water-cycle.html，讲解蒸发、凝结、降水；不依赖网络资源，标题含 WATER_${seed}，实际回读检查内容。本次只做文件生成与静态回读核验，不要求浏览器、截图或滚动验证，请勿额外打开浏览器。`, file: 'water-cycle.html', check: value => {
      assert(value.includes(`WATER_${seed}`)); assert(/蒸发/.test(value) && /凝结/.test(value) && /降水/.test(value));
      assert(!/\b(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(value));
      assert(!/url\(\s*["']?(?:https?:)?\/\//i.test(value));
    } },
  ];
  for (const task of cases) {
    const row = { name: task.name, status: 'running', startedAt: Date.now(), providerStart: requests.length }; report.issue43.cases.push(row); persist();
    const text = `这是一个新的独立目标 CASE43_${task.name}_${seed}。联系 ${target.bot.displayName}：${task.goal} 你负责联系并把它的答复或成果整理给我，不替它直接操作文件，不建团队。`;
    try {
      await send(text);
      let source, relation, receiver, lastJournal;
      await poll(async () => {
        const h = await history(); const input = h.messages.findLast(message => message.role === 'user' && message.text === text);
        source = input && h.messages.find(message => message.role === 'assistant' && message.requestId === input.requestId);
        relation = source?.collaborations?.find(item => item.targetBotId === b);
        if (source && ['failed', 'cancelled', 'unknown'].includes(source.status)) throw Error(source.error || source.text);
        return Boolean(relation);
      }, 'A persistent receive receipt');
      row.collaborationId = relation.collaborationId; row.aRequestId = source.requestId;
      await poll(async () => {
        const active = await api('activeRequests', undefined).catch(() => []);
        receiver = active.find?.(item => item.message?.peerOrigin?.kind === 'request' && item.message.peerOrigin.collaborationId === relation.collaborationId)?.message ?? receiver;
        lastJournal = await journal(relation.collaborationId);
        const h = await history();
        row.returnMessages = h.messages.filter(message => message.peerOrigin?.kind === 'return' && message.peerOrigin.collaborationId === relation.collaborationId);
        const finished = h.messages.filter(message => message.role === 'assistant' && message.peerOrigin?.kind === 'return'
          && message.peerOrigin.collaborationId === relation.collaborationId && message.status === 'completed');
        if (task.direct) return finished.some(message => task.answer.test(message.text));
        const workId = lastJournal.collaboration.workId;
        if (!workId) return false;
        const work = await api('getWork', workId); row.workId = workId; row.work = work;
        if (work.lifecycle === 'closed' && work.closureConclusion !== 'succeeded') throw Error(JSON.stringify(work));
        const reportIds = new Set(lastJournal.messages.filter(message => message.workFeedback?.category === 'result'
          && message.workFeedback.report?.current && message.workFeedback.intentRevision === work.intentRevision
          && message.workFeedback.inputSnapshotId === work.inputSnapshotId).map(message => message.messageId));
        return work.lifecycle === 'closed' && work.closureConclusion === 'succeeded'
          && finished.some(message => reportIds.has(message.peerOrigin.replyMessageId)) && fs.existsSync(path.join(bCwd, task.file));
      }, 'B decision, execution and A result return');
      row.receiver = lastJournal.receivers?.[0] ?? receiver; row.journal = lastJournal;
      assert(row.receiver?.requestId, 'real durable B foreground receipt identity is exposed independently of stream timing');
      if (task.direct) assert.equal(lastJournal.collaboration.workId, null);
      else {
        assert.equal(row.work.ownerBotId, b); assert(!row.work.team);
        const file = path.join(bCwd, task.file), value = fs.readFileSync(file, 'utf8'); task.check(value);
        assert(!fs.existsSync(path.join(aCwd, task.file)));
        row.artifact = { file, sha256: crypto.createHash('sha256').update(value).digest('hex'), contents: value };
      }
      assert(lastJournal.events.some(event => event.kind === 'delivered'));
      assert(lastJournal.events.some(event => event.kind === 'started'));
      row.status = 'passed';
    } catch (error) { row.status = 'failed'; row.error = String(error.stack || error); throw error; }
    finally { row.endedAt = Date.now(); row.providerEnd = requests.length; persist(); }
  }
  const allWorks = await api('listWorks', true);
  assert.equal(allWorks.length, cases.filter(task => !task.direct).length, 'one Work per executable goal, none from simple admission');
  assert.equal(new Set(report.issue43.cases.filter(row => row.workId).map(row => row.workId)).size, allWorks.length);
  const screenshot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, 'issue43-results.png'), Buffer.from(screenshot.data, 'base64'));
  report.checks.push('issue43 six real model categories: B normal foreground decisions, own configuration/Work, exact files and A result return');
};
