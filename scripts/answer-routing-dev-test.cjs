const assert = require("node:assert/strict");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, until, report, rpc } = env;
  const { click, press, fill, expand, openSettings, screenshot } = routingControls(env);
  await openSettings();
  await until(() => evaluate("document.querySelector('.answer-routing-list')?.textContent.includes('还没有规则')"), "empty rules list");
  assert.equal(await evaluate("!!document.querySelector('.answer-rule-form')"), false);
  const routingPage = name => click(name, ".answer-routing-tabs");
  const openAdvanced = () => press("document.querySelector('.answer-routing-policy-advanced > summary')", "展开进阶设置");
  if (process.argv.includes("--flow")) {
    const flow = ".answer-flow";
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.answer-routing-tabs button')].map(b=>b.textContent)"), ["策略", "流程", "规则"]);
    await routingPage("流程");
    assert.equal(await evaluate("document.querySelector('.answer-routing-list').checkVisibility()"), false);
    await click("新增分支", flow);
    await fill('[aria-label="分支 1 名称"]', "客户报价");
    await fill('[aria-label="分支 1 判断 1 短语 1"]', "客户 A");
    await click("为分支 1 添加判断节点", flow);
    await fill('[aria-label="分支 1 判断 2 短语 1"]', "发票");
    await click("为分支 1 判断 2 添加并行短语", flow);
    await fill('[aria-label="分支 1 判断 2 短语 2"]', "报价单");
    await fill('[aria-label="分支 1 的处理方式"]', "delegate");
    await routingPage("规则");
    await click("新增规则");
    await click("取消");
    await routingPage("流程");
    assert.equal(await evaluate("document.querySelector('[aria-label=\"分支 1 名称\"]').value"), "客户报价");
    await click("新增分支", flow);
    await fill('[aria-label="分支 2 名称"]', "普通报价");
    await fill('[aria-label="分支 2 判断 1 短语 1"]', "报价单");
    await fill('[aria-label="分支 2 的处理方式"]', "direct");
    await press("document.querySelector('.answer-flow input[type=checkbox]')", "启用流程");
    await click("保存流程", flow);
    await until(() => evaluate("window.api.answerRouting.list().then(r=>r.some(row=>row.policy?.flow?.enabled))"), "flow saved");
    const askFlow = async () => {
      await fill('[aria-label="测试匹配的问题"]', "客户 A 要一份报价单");
      await click("测试匹配");
      await until(() => evaluate("!!document.querySelector('.answer-flow-trace')"), "flow trace");
      return await evaluate("document.querySelector('.answer-rule-result').textContent");
    };
    const before = await askFlow();
    assert.match(before, /优先委派.*采用分支「客户报价」.*发票”未命中.*报价单”命中/s);

    await rpc("Page.bringToFront");
    await rpc("Emulation.setFocusEmulationEnabled", { enabled: true });
    const points = await evaluate(`(() => {
      const source = document.querySelector('.answer-flow [aria-label="拖动分支 2"]');
      source.scrollIntoView({block:'center', behavior:'instant'});
      const from = source.getBoundingClientRect();
      const dest = document.querySelector('.answer-flow__branch').getBoundingClientRect();
      const start = {x:from.x + from.width / 2, y:from.y + from.height / 2};
      const end = {x:start.x, y:dest.bottom - 28};
      if (source.matches(':disabled') || !source.contains(document.elementFromPoint(start.x,start.y)) || !document.querySelector('.answer-flow__branch').contains(document.elementFromPoint(end.x,end.y))) throw Error('Drag handles or drop target clipped');
      window.answerFlowPointer = [];
      for (const type of ['pointerdown','pointerup','gotpointercapture','lostpointercapture']) {
        document.addEventListener(type, event => window.answerFlowPointer.push([type,event.isTrusted,event.isPrimary,event.target.getAttribute('aria-label'),event.clientX,event.clientY,document.elementFromPoint(event.clientX,event.clientY)?.closest('.answer-flow__branch')?.querySelector('input')?.value]), { capture:true, once:true });
      }
      return {start,end};
    })()`);
    await rpc("Input.dispatchMouseEvent", {type: "mouseMoved", ...points.start});
    await rpc("Input.dispatchMouseEvent", {type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...points.start});
    for (const fraction of [0.2, 0.5, 0.8, 1]) {
      await rpc("Input.dispatchMouseEvent", {type: "mouseMoved", button: "left", buttons: 1,
        x: points.start.x + fraction * (points.end.x - points.start.x), y: points.start.y + fraction * (points.end.y - points.start.y)});
    }
    await rpc("Input.dispatchMouseEvent", {type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...points.end});
    const moved = await evaluate(`new Promise(resolve => requestAnimationFrame(() => resolve({first: document.querySelector('[aria-label="分支 1 名称"]').value, events: window.answerFlowPointer})))`);
    assert.equal(moved.first, "普通报价", JSON.stringify({ points, ...moved }));
    assert.ok(moved.events.some(([type, trusted, , label]) => type === "pointerup" && trusted && label === "拖动分支 2"));
    await click("下移分支 1", flow);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"分支 1 名称\"]').value"), "客户报价");
    await click("上移分支 2", flow);
    await click("保存流程", flow);
    await until(() => evaluate("window.api.answerRouting.list().then(r=>r.some(row=>row.policy?.flow?.branches[0]?.title==='普通报价'))"), "reordered flow saved");
    assert.match(await askFlow(), /优先直答.*采用分支「普通报价」/s);
    await routingPage("策略");
    assert.equal(await evaluate("document.querySelector('.answer-flow').checkVisibility()"), false);
    await openAdvanced();
    const visibleSilence = () => evaluate("document.querySelector('[name=silence]').checkVisibility()");
    assert.equal(await visibleSilence(), false);
    await fill('[name="heartbeat"]', "10");
    assert.equal(await visibleSilence(), true);
    await fill('[name="heartbeat"]', "");
    assert.equal(await visibleSilence(), false);
    await fill('input[name="calls"]', "3");
    await click("保存默认策略");
    await until(() => evaluate("window.api.answerRouting.list().then(r=>r.some(row=>row.policy?.foregroundReadLimits.calls===3 && row.policy.flow.branches[0].title==='普通报价'))"), "flow preserved by default policy editing");
    await env.restart();
    await openSettings();
    await routingPage("流程");
    assert.match(await askFlow(), /优先直答.*采用分支「普通报价」/s);
    await fill('[aria-label="分支 1 名称"]', "本地草稿");
    await evaluate(`(async () => {
      const fallback = (await window.api.answerRouting.list()).find(rule=>rule.id==='dots-default-policy');
      fallback.policy.flow.branches[0].title = '另一处保存';
      await window.api.answerRouting.save(fallback, fallback);
    })()`);
    await click("保存流程", flow);
    await until(() => evaluate("document.querySelector('.answer-routing-error')?.textContent.includes('已变化')"), "stale save rejected");
    await click("刷新已保存设置");
    await until(() => evaluate("document.querySelector('.answer-flow [role=alert]')?.textContent.includes('有新版本')"), "flow change shown");
    assert.equal(await evaluate("document.querySelector('[aria-label=\"分支 1 名称\"]').value"), "本地草稿");
    await click("放弃修改", flow);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"分支 1 名称\"]').value"), "另一处保存");
    assert.equal(env.requests.length, 0, "preview triggers no model request");
    report.actualControlChecks.push("Three scheduling pages are separate. Serial and parallel flow edits survive rule editing, drag and buttons reorder, default settings and restart preserve the flow, and a stale draft cannot overwrite a newer flow.");
    return;
  }
  await routingPage("策略");
  await fill('select[name="routeMode"]', "direct");
  await openAdvanced();
  await fill('input[name="calls"]', "3");
  await click("保存默认策略");
  await until(() => evaluate("window.api.answerRouting.list().then(rows=>rows.some(r=>r.id==='dots-default-policy' && r.revision===2 && r.policy.routeMode==='direct' && r.policy.foregroundReadLimits.calls===3))"), "default strategy revision persisted");
  await routingPage("规则");
  await click("周报核对发布记录示例");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"任务目录相对路径\"]').value"), "");
  assert.equal(await evaluate("[...document.querySelectorAll('.answer-rule-form button')].find(b=>b.textContent==='保存规则').disabled"), true);
  await click("取消");
  await click("查询出行天气示例");
  await click("保存规则");
  await until(() => evaluate("window.api.answerRouting.list().then(r => r.length === 2)"), "rule saved");
  await until(() => evaluate("!!document.querySelector('[data-routing-graph=definition]')"), "rule flow");
  const ask = async query => {
    await fill('[aria-label="测试匹配的问题"]', query);
    await click("测试匹配");
    await until(() => evaluate("!!document.querySelector('.answer-rule-result')"), "match result");
    return evaluate("document.querySelector('.answer-rule-result').textContent");
  };
  assert.match(await ask("上海要带伞吗"), /查询出行天气/);
  await until(() => evaluate("!!document.querySelector('[data-routing-graph=preview]')"), "preview flow");
  const graph = '[data-routing-graph=preview]';
  const zoom = () => evaluate("Number.parseInt(document.querySelector('.routing-graph output').textContent)");
  await until(async () => (await zoom()) > 25, "visible canvas measured");
  const fit = await zoom();
  await click("放大", graph);
  await until(async () => await zoom() > fit, "zoom in");
  await click("适配画布", graph);
  await until(async () => await zoom() === fit, "fit to viewport");
  await click("匹配规则", graph);
  assert.match(await evaluate("document.querySelector('.routing-graph__details').textContent"), /要带伞吗/);
  const transform = () => evaluate("document.querySelector('.routing-graph__diagram').style.transform");
  const start = await transform();
  await rpc("Page.bringToFront");
  await rpc("Emulation.setFocusEmulationEnabled", {enabled: true});
  await evaluate("(() => { const stage=document.querySelector('.routing-graph__stage'); stage.focus(); stage.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); })()");
  await until(async () => await transform() !== start, "canvas moved right");
  await click("适配画布", graph);
  await until(async () => await transform() === start, "canvas refitted");
  await click("展开画布", graph);
  await until(() => evaluate("!!document.querySelector('dialog[open] .routing-graph__stage')"), "expanded canvas");
  const nodeBox = () => evaluate("(() => { const node=document.querySelector('dialog[open] button[aria-label=匹配规则]'); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,left:node.style.left}; })()");
  await until(() => evaluate("document.querySelector('dialog[open] .routing-graph__stage').getBoundingClientRect().height > 300"), "large canvas laid out");
  const node = await nodeBox();
  const connectors = () => evaluate("[...document.querySelectorAll('dialog[open] .routing-graph__diagram svg g path')].map(p=>p.getAttribute('d')).join(' ')");
  const edgesBefore = await connectors();
  await rpc("Input.dispatchMouseEvent", {type: "mouseMoved", x: node.x, y: node.y});
  await rpc("Input.dispatchMouseEvent", {type: "mousePressed", x: node.x, y: node.y, button: "left", buttons: 1, clickCount: 1});
  await rpc("Input.dispatchMouseEvent", {type: "mouseMoved", x: node.x+20, y: node.y+5, button: "left", buttons: 1});
  await rpc("Input.dispatchMouseEvent", {type: "mouseMoved", x: node.x+55, y: node.y+12, buttons: 1});
  await rpc("Input.dispatchMouseEvent", {type: "mouseReleased", x: node.x+55, y: node.y+12, button: "left"});
  await until(async () => (await nodeBox()).left !== node.left && (await connectors()) !== edgesBefore, "node dragged with connectors");
  await click("恢复布局", graph);
  await until(async () => (await connectors()) === edgesBefore, "nodes and connectors restored");
  await screenshot("match-flow");
  await click("关闭大图", graph);
  assert.match(await ask("润色这段天气提醒"), /默认调度策略/);
  await click("查询出行天气");
  await click("停用");
  await until(() => evaluate("window.api.answerRouting.list().then(r => !r.find(rule => rule.title === '查询出行天气').enabled)"), "disabled rule persisted");
  assert.match(await ask("上海要带伞吗"), /默认调度策略/);
  assert.equal(await evaluate("window.api.answerRouting.history().then(r=>r.length)"), 0);

  await click("新增规则");
  await fill('[aria-label="遇到什么问题"]', "交付报告");
  await fill("#answer-rule-instruction", "交付前检查记录编号。");
  await expand("匹配问法与例外");
  await fill('.answer-rule-form input[maxlength="90"]', "交付核对");
  await click("保存规则");
  await until(() => evaluate("window.api.answerRouting.list().then(r => r.length === 3)"), "rule saved");
  assert.match(await ask("生成交付报告"), /交付核对/);
  await screenshot("rules-and-flow");
  assert.equal(env.requests.length, 0);
  const api = (method, arg) => evaluate("window.api." + method + "(" + JSON.stringify(arg) + ")");
  const {id: taskId} = await evaluate("window.api.dots.open()");
  const rule = (await evaluate("window.api.answerRouting.list()")).find(item => item.title === "交付核对");
  await env.restart(() => {
    const db = new DatabaseSync(path.join(env.home, ".mybuddy", "app.db"));
    try {
      db.exec("ALTER TABLE answer_rule_turns DROP COLUMN status");
      const insert = db.prepare(`INSERT INTO answer_rule_turns(task_id,input_id,rule_id,revision,title,at,detail,phrase,evidence,scope)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const status of ["not-found", "revoked"]) {
        insert.run(taskId, status, rule.id, rule.revision, rule.title, Date.now(), "历史资料记录", "交付报告",
          JSON.stringify({kind: "task-file", reference: "release.md", status}), "{}");
      }
      assert.throws(() => db.prepare("SELECT status FROM answer_rule_turns"), /no such column: status/);
    } finally { db.close(); }
  });
  const recovered = await api("answerRouting.history", {taskId, inputIds: ["not-found", "revoked"]});
  assert.deepEqual(recovered.map(row => [row.inputId, row.evidence.status, row.routeStatus]).sort(),
    [["not-found", "not-found", "applied"], ["revoked", "revoked", "revoked"]]);
  assert.equal((await evaluate("window.api.answerRouting.history()")).length, 2);
  assert.deepEqual(await api("answerRouting.history", {taskId, inputId: "no-match"}), []);
  await openSettings();
  await until(() => evaluate("!!document.querySelector('.answer-routing-rule[aria-label=交付核对]')"), "settings loaded after restart");
  assert.equal(await evaluate("!!document.querySelector('.answer-routing-error')"), false);

  const question = "生成交付报告", inputId = "current-delivery";
  const {receipt} = await api("agent.prompt", {taskId, welcomeMode: "general", text: question,
    userMessageId: inputId, assistantMessageId: "delivery-answer"});
  assert.ok(receipt);
  const done = await api("agent.waitForSubmission", receipt);
  assert.ok(!done.error && !done.cancelled, JSON.stringify(done));
  await evaluate(`import('/src/store/appStore.ts').then(({useAppStore}) => {
    const store = useAppStore.getState(); store.setSettingsOpen(false); return store.openDots();
  })`);
  await until(() => evaluate("!!document.querySelector('[data-routing-receipt=current-delivery]')"), "chat loaded the new turn receipt");
  const button = '.message-list button[aria-label="下次这样答"]';
  assert.equal(await evaluate(`document.querySelector('${button}').textContent`), "");
  assert.ok(await evaluate(`!!document.querySelector('${button} svg')`));
  await click("下次这样答", ".message-list");
  await until(() => evaluate("!!document.querySelector('.answer-rule-form details')"), "icon opens this answer's rule draft");
  const source = await evaluate("document.querySelector('.answer-rule-original').textContent");
  assert.equal(await evaluate("document.querySelector('[aria-label=遇到什么问题]').value"), question);
  assert.ok(source.includes("交付测试回答"), source);
  await until(() => evaluate("[...document.querySelectorAll('.answer-rule-save button')].some(button => button.textContent === '更新规则并返回对话')"), "existing rule loaded in teaching dialog");
  await api("answerRouting.save", {title: "交付报告特例", include: [question], exclude: [], instruction: "先核对交付编号。",
    evidenceFile: "", projectId: null, sourceMemoryId: null, enabled: true});
  await click("更新规则并返回对话");
  await click("查看规则", ".answer-rule-confirmation");
  await until(() => evaluate("!!document.querySelector('.dots-config .answer-routing-rule[aria-label=交付报告特例]')"), "chat review opens the rule list in Dots settings");
  assert.equal(await evaluate("document.querySelector('.dots-config nav > button:first-child[aria-pressed=true]')?.textContent.trim()"), "调度");
  report.actualControlChecks.push("Existing history survives a missing status column, and the chat teaching flow opens the rule list in the first Dots settings tab.");
  await require("./answer-routing-weather-check.cjs")(env);
}, {name: "answer-routing", settings: {memoryEnabled: true}, watchRenderer: false,
  fixtureModel: request => JSON.stringify(request.messages).includes("QH-672") ? "晴，站点 QH-672。" : "交付测试回答"});
