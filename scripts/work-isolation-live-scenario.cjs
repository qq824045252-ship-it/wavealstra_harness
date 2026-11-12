/** Real application acceptance. All local data below is synthetic and isolated. */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), net = require('node:net');
exports.run = async ({ send, until, evaluate, history, rpc, report, requests, rawUsageAudit, out, home, modelKey, botId, restart }) => {
  const workspace = path.join(home, 'issue21-inputs'); fs.mkdirSync(workspace, { recursive: true });
  const nonce = crypto.randomBytes(8).toString('hex'), marker = 'READBACK-' + nonce;
  fs.writeFileSync(path.join(workspace, 'source.txt'), marker + '\n');
  fs.writeFileSync(path.join(workspace, 'sales.csv'), 'product,units,price\nTea,3,12\nCoffee,2,25\nCake,4,8\n');
  const dbPath = path.join(home, '.mybuddy/app.db'), sentinel = path.join(workspace, 'legacy-must-not-run.txt');
  const sql = (program, ...args) => JSON.parse(cp.execFileSync('python3', ['-c', program, dbPath, ...args], { encoding: 'utf8' }));
  report.cases = []; report.failures = []; report.coverage = {
    actual: 'pnpm dev, real Electron/preload, real online model, real public network and disk tools',
    synthetic: 'isolated input files and seeded historical quarantine/approval records',
    notTested: ['Windows', 'physical keyboard/mouse input', 'live team/subagent/Code Mode'],
  };
  const persist = () => {
    report.modelCalls = requests.length; report.actualModels = [...new Set(requests.map(r => r.model))];
    fs.writeFileSync(path.join(out, 'isolation-progress.json'), JSON.stringify(report, null, 2));
  };
  // Restart the real app around the old-profile injection; never touch the user's profile.
  await restart(async () => {
    report.legacySeed = sql(`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);before={t:c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['bots','tasks','works']}
c.executescript("""CREATE TABLE work_resource_leases(token INTEGER PRIMARY KEY,state TEXT,owner_json TEXT,resources_json TEXT);
CREATE TABLE work_resource_recovery(token INTEGER PRIMARY KEY REFERENCES work_resource_leases(token));
CREATE TABLE work_action_approvals(approval_id TEXT PRIMARY KEY,data_json TEXT);
CREATE TABLE work_deferred_actions(approval_id TEXT PRIMARY KEY REFERENCES work_action_approvals(approval_id),payload_json TEXT,state TEXT);
INSERT INTO work_resource_leases VALUES(21,'quarantined','{}','[{"kind":"host","key":"legacy-host","mode":"write"}]');
INSERT INTO work_resource_recovery VALUES(21);""")
for state in ['pending','queued','running']:
 id='legacy-'+state;c.execute('INSERT INTO work_action_approvals VALUES(?,?)',(id,json.dumps({'status':state})))
 c.execute('INSERT INTO work_deferred_actions VALUES(?,?,?)',(id,json.dumps({'tool':'write','path':sys.argv[2],'content':state}),state))
c.commit();print(json.dumps({'businessCounts':before,'seededOutboxStates':['pending','queued','running'],'quarantinedHost':True}))`, sentinel);
  });
  report.afterLegacyRestart = sql(`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({'retiredTables':[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE name IN ('work_resource_leases','work_resource_recovery','work_action_approvals','work_deferred_actions')")], 'businessCounts':{t:c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['bots','tasks','works']},'quickCheck':c.execute('PRAGMA quick_check').fetchone()[0],'foreignKeyErrors':c.execute('PRAGMA foreign_key_check').fetchall()}))`);
  assert.deepEqual(report.afterLegacyRestart.retiredTables, []);
  assert.deepEqual(report.afterLegacyRestart.businessCounts, report.legacySeed.businessCounts);
  assert.equal(report.afterLegacyRestart.quickCheck, 'ok'); assert.deepEqual(report.afterLegacyRestart.foreignKeyErrors, []);
  assert(!fs.existsSync(sentinel), 'historical actions must not replay on restart');
  const installEvents = () => evaluate(`(()=>{window.__isolationEvents=[];window.__isolationUnsubscribe?.();window.__isolationUnsubscribe=window.api.agent.onEvent(e=>window.__isolationEvents.push({...e,observedAt:Date.now()}));return true})()`);
  await installEvents();
  const spaceId = 'isolation-' + nonce;
  await evaluate(`window.api.db.upsertSpace(${JSON.stringify({ id: spaceId, name: 'Issue 21 isolated acceptance', path: workspace, createdAt: Date.now(), updatedAt: Date.now() })})`);
  const retired = /共享资源已隔离|等待原执行、后端队列|等待.*workspace:write.*授权|缺.*scope/;
  async function section(name, kind, run) {
    const row = { name, kind, startedAt: Date.now(), status: 'running', requestStart: requests.length }; report.cases.push(row); persist();
    try { await run(row); row.status = 'passed'; }
    catch (error) { row.status = 'failed'; row.error = String(error.stack || error); report.failures.push(name + ': ' + error.message); }
    finally { row.finishedAt = Date.now(); row.requestEnd = requests.length; persist(); console.log(row.status.toUpperCase() + ' issue21 ' + name); }
  }
  async function native(row, text, existingTaskId) {
    const taskId = existingTaskId || 'issue21-' + crypto.randomUUID(); row.taskId = taskId;
    if (!existingTaskId) await evaluate(`window.api.db.upsertTask(${JSON.stringify({ id: taskId, title: row.name, spaceId, cwd: workspace, updatedAt: Date.now(), welcomeMode: 'working', modelId: modelKey, permissionMode: 'readonly' })})`);
    const assistantMessageId = crypto.randomUUID();
    const req = { taskId, text, spaceId, modelId: modelKey, welcomeMode: 'working', modePresetId: 'native', permissionMode: 'readonly', userMessageId: crypto.randomUUID(), assistantMessageId };
    row.prompt = text;
    await evaluate(`(()=>{window.api.agent.prompt(${JSON.stringify(req)}).then(r=>window.__isolationSubmission=r,e=>window.__isolationError=String(e));return true})()`);
    try {
      await until(() => evaluate(`window.__isolationEvents.some(e=>e.type==='assistant_end'&&e.taskId===${JSON.stringify(taskId)}&&e.messageId===${JSON.stringify(assistantMessageId)})`), 'ordinary completion ' + row.name);
      row.events = await evaluate(`window.__isolationEvents.filter(e=>e.taskId===${JSON.stringify(taskId)})`);
      const last = row.events.filter(e => e.type === 'assistant_end').at(-1); assert(!last?.error, last?.error);
      row.history = await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
      assert(!row.events.some(e => e.status === 'pending_approval'), 'retired approval surfaced');
      assert(!row.events.some(e => e.type === 'tool_update' && retired.test(e.output || '')), 'retired resource blocker surfaced');
      row.tools = row.events.filter(e => e.type === 'tool_start').map(e => e.tool);
      return row.events.filter(e => e.type === 'text_delta').map(e => e.delta || '').join('');
    } finally {
      if (!row.events) await evaluate(`window.api.agent.abort(${JSON.stringify(taskId)})`).catch(() => {});
    }
  }
  let diskTask;
  await section('ordinary filesystem verification', 'filesystem', async row => {
    const text = await native(row, `执行真实磁盘验收：读取 ${path.join(workspace,'source.txt')}，创建 ${path.join(workspace,'native-output')} 目录，把读取的完整内容分别写入 one.txt 和 two.txt，再 read 两个文件并执行 ls、wc、stat 复核。最后给出读到的完整标记和两个文件大小。不要请求确认，不使用后台 Work。`);
    diskTask = row.taskId;
    for (const file of ['one.txt', 'two.txt']) assert.equal(fs.readFileSync(path.join(workspace,'native-output',file),'utf8').trim(), marker);
    assert(text.includes(marker)); assert(row.tools.includes('read') && row.tools.includes('write'));
  });
  await section('ordinary public information research', 'public-search', async row => {
    await native(row, '使用 web_search 搜索 IANA Example Domains 的公开用途，给出真实搜索结果 URL 和一句话结论。若实际网络失败就报告具体错误，不编造结果，不反复重试，也不改做后台 Work。');
    assert(row.tools.includes('web_search'), 'real search tool not invoked');
    const errors = row.events.filter(e => e.type==='tool_update' && e.status==='error');
    row.networkErrors = errors; assert.equal(errors.length, 0, 'public search returned a real network/tool failure; not an isolation failure');
  });
  await section('ordinary public webpage extraction', 'browser-reading', async row => {
    const text = await native(row, '用内置 browser_exec navigate 打开 https://example.com，然后 browser_exec read 提取标题与正文并回复。必须实际打开读取，不用 fetch、curl、截图替代。不要创建后台 Work。');
    assert(row.tools.filter(t=>t==='browser_exec').length>=2); assert.match(text,/Example Domain/i);
    assert(!row.events.some(e=>e.type==='tool_update'&&e.status==='error'), 'browser operation failed');
  });
  const closedPort = await new Promise(resolve => { const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));}); });
  await section('ordinary network failure diagnosis', 'network-diagnosis', async row => {
    const text = await native(row, `使用 bash 分别 curl --max-time 15 https://example.com 和 curl --max-time 3 http://127.0.0.1:${closedPort}/ 。第二个地址故意没有服务。报告每个命令实际退出码和真实错误，不能重试、不用后台 Work、不把失败改成成功。`);
    assert(row.tools.some(t=>['bash','execute','shell'].includes(t)), 'real shell was not called');
    assert.match(JSON.stringify(row.events), /Connection refused|Failed to connect|ECONNREFUSED|连接.*拒绝|无法连接/i);
    assert.match(text,/Example Domain|example\.com/i);
  });
  const settings = (await evaluate(`window.api.botWork.getSettings(${JSON.stringify(botId)})`)).settings;
  assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
  const details = id => evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
  async function botWork(row, prompt, expectedFile) {
    const before = new Set((await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId));
    row.prompt=prompt; await send(prompt);
    row.user=(await history()).messages.filter(m=>m.role==='user').at(-1); assert(row.user?.requestId);
    await until(async()=>{row.answer=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===row.user.requestId&&['completed','failed','cancelled','unknown'].includes(m.status));return row.answer;},'Bot foreground '+row.name);
    let work;
    await until(async()=>{work=(await evaluate('window.api.botWork.listWorks(true)')).find(w=>!before.has(w.workId));return work;},'real Work dispatch '+row.name);
    row.workId=work.workId;
    await until(async()=>{row.work=await details(work.workId);return row.work.executions.some(e=>['completed','failed','stopped'].includes(e.status));},'real Work terminal '+row.name);
    row.nativeHistories=[];
    for(const binding of row.work.executions) row.nativeHistories.push(await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(binding.taskId)})`));
    await until(async()=>{row.feedback=(await history()).messages.filter(m=>m.workIds?.includes(work.workId)&&['result','decision'].includes(m.workFeedback?.category));return row.feedback.length;},'result returned to Bot conversation '+row.name);
    assert(row.work.executions.some(e=>e.status==='completed'),'no successful real execution');
    assert(fs.existsSync(path.join(workspace,expectedFile)),'expected actual output missing');
    assert(!retired.test(JSON.stringify(row.nativeHistories)), 'retired isolation or scope denied Bot');
    await until(async()=>{row.finalWork=await details(work.workId);return row.finalWork.lifecycle==='closed';},'business completion '+row.name);
    assert.equal(row.finalWork.closureConclusion,'succeeded');
    row.visibleFeedback=await evaluate(`(()=>{const ids=${JSON.stringify(row.feedback.map(m=>m.messageId))};return ids.map(id=>({id,text:document.querySelector('[data-message-id="'+id+'"]')?.innerText||null}));})()`);
  }
  await section('Bot background tabular analysis', 'data-analysis', async row => {
    await botWork(row, `请创建并立即执行一个一次性后台事项，标题“I21销售分析”。工作目录 ${workspace}。实际读取 sales.csv，计算每项金额与总额，写 sales-summary.txt 和 sales-detail.csv；两者必须包含总额118。用 read/ls/wc/stat复核，向当前会话交付两个实际文件并完成业务验收。不要计划定时检查。`, 'sales-summary.txt');
    assert.match(fs.readFileSync(path.join(workspace,'sales-summary.txt'),'utf8'),/118/);
    assert(fs.existsSync(path.join(workspace,'sales-detail.csv')));
  });
  await section('Bot background sourced document writing', 'document-writing', async row => {
    await botWork(row, `请创建并立即执行另一个一次性后台事项，标题“I21公开网页简报”。工作目录 ${workspace}。用 browser_exec navigate/read 实际打开 https://example.com，再读取 source.txt，把网页标题、用途、来源URL、source.txt完整标记写入 public-brief.md，同时写一份 public-brief.txt。用read/ls/wc/stat复核，向当前会话交付两个实际文件并完成业务验收。不得把已知标题当实际读取。`, 'public-brief.md');
    const result=fs.readFileSync(path.join(workspace,'public-brief.md'),'utf8');assert.match(result,/Example Domain/i);assert(result.includes(marker));
    assert(fs.existsSync(path.join(workspace,'public-brief.txt')));
    assert(JSON.stringify(row.nativeHistories).includes('browser_exec'),'Bot browser tool not evidenced');
  });
  // Reopen once more after real actions, then continue the original native task.
  await section('restart continuation without historical replay', 'same-session-restart', async row => {
    assert(diskTask,'initial filesystem task was not accepted'); await restart(); await installEvents();
    const text=await native(row, `这是重启后的同一会话核验。只读 ${path.join(workspace,'native-output/one.txt')}，不写任何文件，回复其中的完整标记。`, diskTask);
    assert(text.includes(marker));assert(!fs.existsSync(sentinel));
    row.finalDb=sql(`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(json.dumps({'quickCheck':c.execute('PRAGMA quick_check').fetchone()[0],'foreignKeyErrors':c.execute('PRAGMA foreign_key_check').fetchall()}))`);
    assert.equal(row.finalDb.quickCheck,'ok');assert.deepEqual(row.finalDb.foreignKeyErrors,[]);
  });
  report.actualUsage=rawUsageAudit.flatMap(r=>r.usage||[]);persist();
  assert(report.cases.length>=6, 'live batch must include at least six semantic task types');
  assert.equal(report.failures.length,0, report.failures.join('\n'));
  report.checks.push('real model six task categories plus same-session restart; old profile retired without replay');
};
