/** Real pnpm dev / Electron / preload / IPC / SQLite acceptance. Never inject renderer or database state. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { launch, desktopPreflight, sourceFingerprint, until, delay } = require('./isolated-electron-dev.cjs');
const { createModel } = require('./bot-task-reply-model.cjs');

const root = path.resolve(__dirname, '..');
const seed = process.env.BOT_TASK_REPLY_SEED || crypto.randomBytes(5).toString('hex');
assert(/^[a-zA-Z0-9_-]{1,40}$/.test(seed), 'BOT_TASK_REPLY_SEED must be 1–40 ASCII letters, digits, underscores or hyphens');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + seed;
const out = path.join(root, 'out/diagnostics/bot-task-replies', runId);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-task-reply-'));
const agentDir = path.join(home, '.mybuddy');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(agentDir, { recursive: true });
const botId = 'bot-mybuddy-default';
const report = { status: 'running', seed, startedAt: new Date().toISOString(), home, output: out,
  platform: process.platform, launchCommand: 'pnpm dev', modelMode: process.env.BOT_TASK_REPLY_MODEL_MODE || 'fixture',
  validatesNativeDesktopInput: false, runs: [], checks: [],
  limitations: ['CDP drives a real Electron renderer; it does not validate native OS keyboard, AT-SPI, Wayland focus, packaging or multi-device delivery.',
    'Fixture mode tests the full local application with a deterministic HTTP model; it does not establish live-model reasoning quality.',
    'Restart checks persisted completed tasks. Mid-tool process crashes and older-history pagination belong to their dedicated suites.'] };
let runtime, model, launchNumber = 0, initialSource;
const persist = () => {
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  if (model) fs.writeFileSync(path.join(out, 'provider-requests.json'), JSON.stringify(model.records, null, 2));
};
const evaluate = expression => runtime.renderer.evaluate(expression);
const rpc = (method, params) => runtime.renderer.rpc(method, params);
const history = () => evaluate(`window.api.botWork.history({botId:${JSON.stringify(botId)}})`);
const works = () => evaluate('window.api.botWork.listWorks(true)');
const cardSelector = task => `.bot-task-reply[data-work-id="${task.workId}"]`;
const tabSelector = (task, stage) => `${cardSelector(task)} [role="tab"][data-stage-id="${stage}"]`;
async function click(expression) {
  const position = await evaluate(`(()=>{const element=(${expression});if(!element)throw Error('Missing UI control');
    if(element.disabled)throw Error('Disabled UI control');element.scrollIntoView({block:'center',inline:'nearest'});
    const r=element.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden UI control');
    return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
  await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
}
const clickSelector = selector => click(`document.querySelector(${JSON.stringify(selector)})`);
async function capture(name) {
  const screenshot = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(screenshot.data, 'base64'));
  const accessibility = await rpc('Accessibility.getFullAXTree');
  fs.writeFileSync(path.join(out, name + '.ax.json'), JSON.stringify(accessibility, null, 2));
  return { screenshot: name + '.png', accessibility: name + '.ax.json' };
}
async function step(id, action, check) {
  const item = { id, action, startedAt: new Date().toISOString(), status: 'running' }; report.checks.push(item); persist();
  try {
    item.observed = await check(); item.status = 'passed';
    if (runtime) item.evidence = await capture(id);
  } catch (error) { item.status = 'failed'; item.error = String(error.stack || error); throw error; }
  finally { item.finishedAt = new Date().toISOString(); persist(); }
}
async function enterBot() {
  await until(() => evaluate('Boolean(window.api?.botWork?.history && document.querySelector(".sidebar-user-main"))'), 'real renderer and preload');
  if (!await evaluate('Boolean(document.querySelector("#bot-draft"))')) {
    await clickSelector('.sidebar-user-main');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent.trim()==="Bot 模式")'), 'Bot menu entry');
    await click('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==="Bot 模式")');
  }
  await until(() => evaluate('Boolean(document.querySelector("#bot-draft"))'), 'original Bot composer');
  assert.equal((await evaluate('window.api.botWork.hostStatus()')).isAuthority, true);
}
async function start() {
  const source = sourceFingerprint(root);
  assert.equal(source.sourceDigest, initialSource.sourceDigest, 'source remains unchanged during this acceptance run');
  runtime = await launch({ root, home, out, launchNumber: ++launchNumber });
  report.runs.push(runtime.identity); persist();
  await enterBot();
}
async function type(text) {
  await clickSelector('#bot-draft'); await rpc('Input.insertText', { text });
  await until(() => evaluate(`document.querySelector('#bot-draft').value===${JSON.stringify(text)}`), 'real controlled draft');
}
async function send(text) {
  assert.equal(await evaluate('document.querySelector("#bot-draft").value'), '');
  await type(text); await clickSelector('.bot-composer button[type=submit]');
  await until(() => evaluate('document.querySelector("#bot-draft").value===""'), 'IPC receipt clears sent draft');
  return until(async () => {
    const page = await history(), user = page.messages.find(message => message.role === 'user' && message.text === text);
    const answer = user && page.messages.find(message => message.role === 'assistant' && message.requestId === user.requestId);
    if (answer && ['failed', 'cancelled', 'unknown'].includes(answer.status)) throw Error('foreground failed: ' + JSON.stringify(answer));
    return answer?.status === 'completed' ? { user, answer, conversationId: page.conversationId } : false;
  }, 'native foreground reply');
}
async function hold(selector) {
  const value = await rpc('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
  assert(value.result?.objectId, 'real DOM reference exists: ' + selector); return value.result.objectId;
}
async function same(objectId, selector) {
  const value = await rpc('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(selector){return this.isConnected&&this===document.querySelector(selector)}',
    arguments: [{ value: selector }], returnByValue: true });
  assert.equal(value.result?.value, true, 'original DOM node survives: ' + selector);
}
async function uiState() {
  return evaluate(`(()=>{const thread=document.querySelector('.bot-thread'),composer=document.querySelector('#bot-draft');return {
    draft:composer.value,composerCount:document.querySelectorAll('#bot-draft').length,composerInReply:!!composer.closest('.bot-task-reply'),
    focus:document.activeElement?.id,scrollTop:thread.scrollTop,scrollHeight:thread.scrollHeight,clientHeight:thread.clientHeight,
    outerAssistantIds:[...thread.querySelectorAll('article.bot-message.assistant')].map(node=>node.dataset.messageId),
    cards:[...thread.querySelectorAll('.bot-task-reply')].map(card=>({workId:card.dataset.workId,replyId:card.closest('article.bot-message')?.dataset.messageId,
      selected:card.querySelector('[role=tab][aria-selected=true]')?.dataset.stageId,status:card.querySelector('.bot-task-reply-status')?.textContent,
      feedbackIds:[...card.querySelectorAll('[data-feedback-message-id]')].map(node=>node.dataset.feedbackMessageId)}))};})()`);
}
function readStored() {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(path.join(agentDir, 'app.db'), { readOnly: true });
  try {
    database.exec('PRAGMA query_only=ON; BEGIN');
    return JSON.parse(JSON.stringify({
      works: database.prepare('SELECT work_id,lifecycle,closure_conclusion,intent_revision,input_snapshot_id FROM works ORDER BY work_id').all(),
      bindings: database.prepare('SELECT binding_id,work_id,task_id,status,intent_revision,input_snapshot_id FROM work_execution_bindings ORDER BY binding_id').all(),
      messages: database.prepare('SELECT message_id,conversation_id,request_id,role,text,status,work_ids_json FROM bot_messages ORDER BY ordinal').all(),
      feedback: database.prepare('SELECT message_id,metadata_json FROM bot_work_feedback ORDER BY message_id').all(),
    }));
  } finally { database.close(); }
}
async function assertBelonging(tasks) {
  const state = await uiState();
  assert.equal(state.composerCount, 1); assert.equal(state.composerInReply, false);
  assert.equal(state.cards.length, tasks.length);
  for (const task of tasks) {
    const cards = state.cards.filter(card => card.workId === task.workId);
    assert.equal(cards.length, 1); assert.equal(cards[0].replyId, task.answerId);
    assert.equal(new Set(cards[0].feedbackIds).size, cards[0].feedbackIds.length, 'one copy per feedback message');
  }
  return state;
}
async function assertResult(task, other) {
  await clickSelector(tabSelector(task, 'result'));
  const text = await until(async () => {
    const value = await evaluate(`document.querySelector(${JSON.stringify(`${cardSelector(task)} [role="tabpanel"][data-stage-id="result"]`)}).innerText`);
    return value.includes(task.result) ? value : false;
  }, 'matching result rendered in its own phase');
  assert(text.includes(task.result), 'own reviewed result appears in original reply');
  assert(!text.includes(other.result), 'parallel result is not mixed into this task');
}

(async () => {
  try {
    persist(); desktopPreflight();
    initialSource = sourceFingerprint(root); report.sourceAtStart = initialSource;
    model = createModel({ seed, mode: report.modelMode });
    const baseUrl = await model.start();
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'reply-test': { api: 'openai-completions',
      apiKey: 'isolated-test-only', baseUrl, models: [{ id: model.modelId, name: 'Isolated task reply test', reasoning: false,
        input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'reply-test', defaultModel: model.modelId,
      enabledModels: ['reply-test/' + model.modelId], memoryEnabled: false, memoryGatewayEnabled: false,
      remoteAccessEnabled: false, residentHostEnabled: false, closeToTray: false, theme: 'light', permissionMode: 'auto' }));
    await step('01-start', 'Launch isolated pnpm dev and open Bot mode through its account menu', async () => {
      await start(); assert.equal((await works()).length, 0); return runtime.identity;
    });
    const tasks = model.tasks;
    await step('02-dispatch', 'Submit two independent tasks through the unchanged composer while the first native execution is held', async () => {
      for (const task of tasks) {
        const sent = await send(`这是独立的新任务 [${task.marker}]。请用 work_create 在后台处理，标题为“${task.title}”，最终只需给我标记 ${task.result}，无需文件；sourceMessageIds 为空数组，不关联其他任务。`);
        assert.equal(sent.answer.workIds.length, 1); task.workId = sent.answer.workIds[0]; task.answerId = sent.answer.messageId;
        task.requestId = sent.user.requestId; task.conversationId = sent.conversationId;
        await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(cardSelector(task))}))`), 'task inserted into original reply');
        if (task.letter === 'A') await until(() => model.hits('execution', 'A') > 0, 'first native model request in flight');
      }
      assert.notEqual(tasks[0].workId, tasks[1].workId); assert.equal(tasks[0].conversationId, tasks[1].conversationId);
      report.tasks = tasks;
      const ping = await send(`后台任务继续运行。这个问题请直接回复“快答完成 ${model.ping}”，不要创建任务。`);
      assert(ping.answer.text.includes(model.ping)); assert.equal((await works()).length, 2);
      return assertBelonging(tasks);
    });
    const [a, b] = tasks;
    const references = await Promise.all(['#bot-draft', cardSelector(a), cardSelector(b), `article[data-message-id="${a.answerId}"]`].map(async selector => ({ selector, id: await hold(selector) })));
    const draft = `未发送草稿 ${seed}`;
    let reading;
    await step('03-tabs-draft', 'Select stages independently, use ArrowRight, then keep an unsent draft while reading earlier content', async () => {
      await clickSelector(tabSelector(a, 'request')); await clickSelector(tabSelector(b, 'review'));
      await clickSelector(tabSelector(a, 'request'));
      await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      let state = await uiState(); assert.equal(state.cards.find(card => card.workId === a.workId).selected, 'execution');
      assert.equal(state.cards.find(card => card.workId === b.workId).selected, 'review');
      await clickSelector(tabSelector(a, 'request'));
      assert(await evaluate(`Array.from(document.querySelectorAll('.bot-task-reply [role=tab]')).every(tab=>{const panel=document.getElementById(tab.getAttribute('aria-controls'));return panel&&panel.getAttribute('aria-labelledby')===tab.id&&tab.closest('.bot-task-reply').contains(panel);})`));
      await type(draft);
      const point = await evaluate(`(()=>{const r=document.querySelector('.bot-thread').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      state = await uiState(); assert(state.scrollHeight > state.clientHeight, 'test conversation really scrolls');
      await rpc('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -400, deltaX: 0 });
      await delay(250); reading = await assertBelonging(tasks);
      assert.equal(reading.draft, draft); assert.equal(reading.focus, 'bot-draft');
      return reading;
    });
    await step('04-background-review', 'Release A at the HTTP provider and observe native completion while its model review is held', async () => {
      model.release('execution', 'A');
      await until(() => model.hits('review', 'A') > 0, 'real result review request');
      const current = await until(async () => (await works()).find(work => work.workId === a.workId && work.executions.some(binding => binding.status === 'completed')), 'native completed execution persisted');
      await until(() => evaluate(`document.querySelector(${JSON.stringify(tabSelector(a, 'review'))})?.dataset.state==='current'`), 'renderer displays the authoritative review phase');
      for (const reference of references) await same(reference.id, reference.selector);
      const state = await assertBelonging(tasks);
      assert.equal(state.draft, draft); assert.equal(state.focus, 'bot-draft');
      assert.equal(state.cards.find(card => card.workId === a.workId).selected, 'request');
      assert.equal(state.cards.find(card => card.workId === b.workId).selected, 'review');
      assert(Math.abs(state.scrollTop - reading.scrollTop) <= 2, 'background progress does not pull the reader to the bottom');
      assert.deepEqual(state.outerAssistantIds, reading.outerAssistantIds, 'feedback does not create another outer assistant reply');
      return { work: current, ui: state };
    });
    await step('05-reviewed-results', 'Release result reviews and inspect each result in its own original reply', async () => {
      model.release('review', 'A');
      await until(async () => (await works()).some(work => work.workId === a.workId && work.lifecycle === 'closed'), 'A closes through production result review');
      for (const reference of references) await same(reference.id, reference.selector);
      let state = await assertBelonging(tasks);
      assert.equal(state.cards.find(card => card.workId === a.workId).selected, 'request'); assert.equal(state.draft, draft);
      await until(() => model.hits('execution', 'B') > 0, 'B independent native request');
      model.release('execution', 'B'); await until(() => model.hits('review', 'B') > 0, 'B result review'); model.release('review', 'B');
      await until(async () => (await works()).every(work => work.lifecycle === 'closed'), 'both tasks finish');
      await until(async () => {
        const page = await history();
        return tasks.every(task => page.messages.some(message => message.status === 'completed'
          && message.workFeedback?.workId === task.workId && message.workFeedback.report?.completion?.nextStep === 'deliver'));
      }, 'each managed task report returns through the persistent original conversation');
      await until(async () => (await Promise.all(tasks.map(task => evaluate(`document.querySelector(${JSON.stringify(tabSelector(task, 'result'))})?.dataset.state==='completed'`)))).every(Boolean), 'renderer displays authoritative successful results');
      await assertResult(a, b); await assertResult(b, a); state = await assertBelonging(tasks);
      assert.equal(state.draft, draft); assert.deepEqual(state.outerAssistantIds, reading.outerAssistantIds);
      const stored = readStored(); assert.equal(stored.works.length, 2); assert.equal(stored.bindings.length, 2);
      assert(stored.works.every(work => work.lifecycle === 'closed' && work.closure_conclusion === 'succeeded'));
      for (const task of tasks) {
        const row = stored.messages.find(message => message.message_id === task.answerId);
        assert.equal(row.conversation_id, task.conversationId); assert.deepEqual(JSON.parse(row.work_ids_json), [task.workId]);
      }
      report.persistedBeforeRestart = stored; return { ui: state, stored };
    });
    await step('06-renderer-reload', 'Reload the real renderer and read the same persistent replies and result records', async () => {
      await rpc('Page.reload', { ignoreCache: true }); await enterBot();
      await until(async () => (await uiState()).cards.length === 2, 'restored task reply cards after renderer reload');
      await assertBelonging(tasks); await assertResult(a, b); await assertResult(b, a);
      assert.deepEqual(readStored(), report.persistedBeforeRestart, 'renderer reload does not rewrite business history');
      return assertBelonging(tasks);
    });
    await step('07-main-restart', 'Stop only the owned main process, relaunch pnpm dev with the same isolated profile, and read back SQLite', async () => {
      const previousPid = runtime.identity.pid;
      await runtime.stop(); runtime = undefined; await start();
      assert.notEqual(runtime.identity.pid, previousPid, 'a new Electron main really started');
      await until(async () => (await uiState()).cards.length === 2, 'restored task reply cards after full restart');
      await assertBelonging(tasks); await assertResult(a, b); await assertResult(b, a);
      assert.deepEqual(readStored(), report.persistedBeforeRestart, 'persistent message/Work/binding identities survive main restart without duplicate facts');
      const executionCounts = tasks.map(task => ({ task: task.letter, requests: model.records.filter(record => record.lane === 'execution' && record.task === task.letter).length }));
      if (report.modelMode === 'fixture') assert(executionCounts.every(item => item.requests === 1), 'completed native work is not rerun after restart');
      return { previousPid, currentPid: runtime.identity.pid, executionCounts, ui: await uiState() };
    });
    await step('08-new-conversation', 'Start a new conversation through the existing dialog and verify old task replies stay in their original conversation', async () => {
      await clickSelector('[aria-label="新对话"]');
      await until(() => evaluate('Boolean(document.querySelector(".bot-settings-dialog[open]"))'), 'new conversation dialog');
      await click('[...document.querySelectorAll(".bot-settings-dialog[open] button")].find(button=>button.textContent==="归档并开始新对话")');
      await until(async () => (await history()).conversationId !== a.conversationId, 'new conversation identity');
      await until(() => evaluate('document.querySelectorAll(".bot-thread .bot-task-reply").length===0'), 'no old reply cards in new conversation');
      const stored = readStored(); assert.deepEqual(stored, report.persistedBeforeRestart, 'archiving does not migrate or duplicate original messages and tasks');
      return { originalConversationId: a.conversationId, newConversationId: (await history()).conversationId };
    });
    assert.deepEqual(model.errors, [], 'no hidden fixture/provider failures');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1;
    if (runtime) try { report.failureEvidence = await capture('failed'); report.visibleText = await evaluate('document.body.innerText'); } catch (captureError) { report.captureError = String(captureError); }
    console.error(report.error);
  } finally {
    try { if (runtime) await runtime.stop(); } catch (error) { report.cleanupError = String(error); report.status = 'failed'; process.exitCode = 1; }
    if (model) {
      try { await model.close(); }
      catch (error) { report.providerCleanupError = String(error); report.status = 'failed'; process.exitCode = 1; }
      report.providerErrors = [...model.errors];
      if (report.providerErrors.length) { report.status = 'failed'; process.exitCode = 1; }
    }
    if (initialSource) {
      report.sourceAtEnd = sourceFingerprint(root);
      if (report.sourceAtEnd.sourceDigest !== initialSource.sourceDigest) { report.status = 'failed'; report.sourceChangedDuringRun = true; process.exitCode = 1; }
    }
    report.finishedAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({ taskReplyDev: report.status, modelMode: report.modelMode, report: path.join(out, 'report.json') }));
  }
})();
