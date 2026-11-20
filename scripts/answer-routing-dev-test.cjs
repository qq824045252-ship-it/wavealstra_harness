const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  const { evaluate, until, report, rpc } = env;
  const { click, fill, expand, openSettings, screenshot } = routingControls(env);
  await openSettings();
  await until(() => evaluate("document.querySelector('.answer-routing-list')?.textContent.includes('还没有规则')"), "empty rules list");
  assert.equal(await evaluate("!!document.querySelector('.answer-rule-form')"), false);
  await click("周报核对发布记录示例");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"任务目录相对路径\"]').value"), "");
  assert.equal(await evaluate("[...document.querySelectorAll('.answer-rule-form button')].find(b=>b.textContent==='保存规则').disabled"), true);
  await click("取消");
  await click("查询出行天气示例");
  await click("保存规则");
  await until(() => evaluate("window.api.answerRouting.list().then(r => r.length === 1)"), "rule saved");
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
  assert.match(await ask("润色这段天气提醒"), /没有匹配规则/);
  await click("停用");
  await until(() => evaluate("window.api.answerRouting.list().then(r => !r[0].enabled)"), "disabled rule persisted");
  assert.match(await ask("上海要带伞吗"), /没有匹配规则/);
  assert.equal(await evaluate("window.api.answerRouting.history().then(r=>r.length)"), 0);

  const memory = await evaluate("window.api.memory.create({kind:'procedure',title:'交付核对',content:'交付前核对签收凭据',scopeType:'global',sourceType:'manual'})");
  await openSettings("memory");
  const namedButton = label => "[...document.querySelectorAll('button')].find(b => b.textContent.includes(" + JSON.stringify(label) + "))";
  await until(() => evaluate("!!(" + namedButton("交付核对") + ")"), "memory visible");
  await evaluate("(" + namedButton("交付核对") + ").click()");
  await click("创建回答规则草稿", "body");
  await until(() => evaluate("!!document.querySelector('.answer-rule-form')"), "memory draft");
  const relation = await evaluate("[...document.querySelectorAll('.answer-rule-form select')].find(s=>[...s.options].some(o=>o.value==='linked')).value");
  assert.equal(relation, "independent");
  assert.equal(await evaluate("document.querySelector('textarea[maxlength=\"2000\"]').value"), "交付前核对签收凭据");
  await click("AI 去重并提炼");
  await until(() => evaluate("document.querySelector('.answer-rule-memory-match')?.textContent.includes('文字相同')"), "exact match without a model server");
  await expand("查看比对依据");
  await click("采用这条记忆的原文并关联");
  assert.equal(await evaluate("[...document.querySelectorAll('.answer-rule-form select')].find(s=>[...s.options].some(o=>o.value==='linked')).value"), "linked");
  await fill('[aria-label="遇到什么问题"]', "交付报告");
  await click("保存规则");
  await until(() => evaluate("window.api.answerRouting.list().then(r => r.length === 2)"), "reviewed rule saved");
  assert.equal(await evaluate("window.api.answerRouting.list().then(r=>r.find(i=>i.title==='交付核对').sourceMemoryId)"), memory.id);
  assert.match(await ask("生成交付报告"), /交付核对/);
  await screenshot("rules-and-flow");
  report.actualControlChecks.push("Empty list, editable memory draft, opt-in source link, save, disable, positive and negative previews without recording an execution, and visual rule flow.");
  assert.equal(env.requests.length, 1, "only the explicitly requested AI distillation calls the model");

  const taskId = "routing-history-task", spaceId = "routing-history-space";
  const api = (method, arg) => evaluate("window.api." + method + "(" + JSON.stringify(arg) + ")");
  await api("db.upsertSpace", {id: spaceId, name: "验收空间", path: mkdtempSync(path.join(env.home, "workspace-"))});
  await api("db.upsertTask", {id: taskId, spaceId, title: "交付核对", welcomeMode: "general", updatedAt: Date.now()});
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
  const {receipt} = await api("agent.prompt", {taskId, spaceId, welcomeMode: "general", text: question,
    userMessageId: inputId, assistantMessageId: "delivery-answer"});
  assert.ok(receipt);
  const done = await api("agent.waitForSubmission", receipt);
  assert.ok(!done.error && !done.cancelled, JSON.stringify(done));
  await evaluate(`import('/src/store/appStore.ts').then(({useAppStore}) => {
    const store = useAppStore.getState(); store.setSettingsOpen(false); store.setActiveTask(${JSON.stringify(taskId)});
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
  report.actualControlChecks.push("Existing history survives a missing status column, settings and chat load, and the icon-only teaching action opens the correct answer.");
  await click("取消");
  await require("./answer-routing-weather-check.cjs")(env);
}, {name: "answer-routing", settings: {memoryEnabled: true}, watchRenderer: false,
  fixtureModel: request => JSON.stringify(request.messages).includes("QH-672") ? "晴，站点 QH-672。" : "交付测试回答"});
