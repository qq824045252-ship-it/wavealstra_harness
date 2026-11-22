const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

run(async env => {
  if (process.argv.includes("--weather")) return require("./answer-routing-weather-check.cjs")(env);
  const { evaluate, until, report, home, requests, restart, rpc } = env;
  const { click, fill, expand, openSettings, screenshot } = routingControls(env);
  const original = "交付记录。蓝桥模块 RG-174 已提测，尚未上线。青禾模块 RG-285 已上线。";
  const updated = "新版发布记录。蓝桥模块 RG-174 已上线，发布批次 R-920。青禾模块 RG-285 已上线。";
  const hash = body => createHash("sha256").update(body).digest("hex");
  const { id: dotsId } = await evaluate("window.api.dots.open()");
  const dbCall = (name, arg) => evaluate("window.api.db." + name + "(" + JSON.stringify(arg) + ")");
  const question = "写项目周报。用两行汇报蓝桥和青禾各自的交付状态与记录编号。";
  const teaching = "写项目周报或整理交付周报时，先读取任务目录的 release.md。区分已提测和尚未上线，列出状态和记录编号。翻译周报时跳过。资料缺失标为待核实。";
  const makeTask = id => dbCall("upsertTask", { id, title: id, welcomeMode: "general", updatedAt: Date.now() });
  const getUses = (taskId, inputId) => evaluate("window.api.answerRouting.history(" + JSON.stringify({ taskId, inputId }) + ")");
  const setMemory = value => evaluate("window.api.agent.updateAppSettings(" + JSON.stringify({memoryEnabled: value}) + ")");
  report.comparison = [];

  const ask = async (arm, id, query, expectedStatus) => {
    const inputId = "q-" + arm;
    const request = { taskId: id, welcomeMode: "general", text: query, userMessageId: inputId, assistantMessageId: "a-" + arm };
    const offset = requests.length, start = Date.now();
    await evaluate("window.answerRun = null; (async () => { const r = await window.api.agent.prompt(" + JSON.stringify(request)
      + "); if (!r.receipt) throw Error(JSON.stringify(r)); const done = await window.api.agent.waitForSubmission(r.receipt);"
      + " if (done.error) throw Error(JSON.stringify(done.error)); const h = await window.api.agent.loadTaskHistory(" + JSON.stringify(id)
      + "); window.answerRun = {answer: h.messages.filter(m => m.role === 'assistant').at(-1)?.text}; })().catch(e => window.answerRun = {error: String(e)}); void 0");
    await until(() => evaluate("!!window.answerRun"), arm);
    const {answer, error} = await evaluate("window.answerRun");
    assert.ifError(error ? Error(error) : null);
    assert.ok(answer, arm + " has an answer");
    const calls = requests.slice(offset).filter(payload => payload.messages.some(m => m.role === "user" &&
      (m.content === query || (Array.isArray(m.content) && m.content.some(p => p.text === query)))));
    const uses = await getUses(id, inputId);
    report.comparison.push({arm, elapsedMs: Date.now()-start, providerRequests: calls.length, answer, uses});
    assert(calls.length > 0);
    assert.equal(uses.length, expectedStatus || id === dotsId ? 1 : 0);
    if (!expectedStatus && id === dotsId) assert.equal(uses[0].ruleId, "dots-default-policy");
    if (expectedStatus) assert.equal(uses[0].evidence.status, expectedStatus);
    return { answer, uses, inputId, calls };
  };

  const checkInitial = answer => {
    const blue = answer.split("\n").find(line => line.includes("蓝桥") && line.includes("RG-174"));
    const green = answer.split("\n").find(line => line.includes("青禾") && line.includes("RG-285"));
    assert(blue && /提测/.test(blue), answer);
    // Strip explicit negations before rejecting a positive claim about the same module.
    assert.doesNotMatch(blue.replace(/(?:尚未|未|没有|并未|还没|暂未)(?:正式)?上线/g, ""), /已(?:经)?(?:正式)?上线|已发布|完成上线/);
    assert(green && /已(?:经)?(?:正式)?上线|完成上线/.test(green), answer);
  };
  const baseline = dotsId, memoryOnly = "routing-memory", runTask = dotsId, both = dotsId;
  await makeTask(memoryOnly);
  await setMemory(false);
  await ask("baseline", baseline, question);
  const { cwd } = await evaluate("window.api.dots.open()");
  const file = path.join(cwd, "release.md");
  await fs.writeFile(file, original);
  await setMemory(true);
  await evaluate("window.api.memory.create(" + JSON.stringify({ title: "周报交付约束", content: teaching,
    scopeType: "global", kind: "procedure", sourceType: "manual", explicit: true }) + ")");
  await ask("memory", memoryOnly, question);
  await setMemory(false);

  await restart();
  const activate = () => evaluate("import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().openDots())");
  await activate(baseline);
  await click("下次这样答", ".message-list");
  await until(() => evaluate("!!document.querySelector('.answer-rule-form textarea')"), "editable teaching card");
  await fill('textarea[aria-label="下次怎么做"]', teaching);
  await expand("规则选项");
  await expand("匹配问法与例外");
  await click("用模型整理成草稿");
  await until(() => evaluate("document.querySelector('[aria-label=\"任务目录相对路径\"]')?.value === 'release.md'"), "teacher supplied source prefilled");
  await evaluate("(() => {const s = [...document.querySelectorAll('.answer-rule-form select')].find(s=>[...s.options].some(o=>o.value==='mark-unverified')); s.value='mark-unverified';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await click("保存并返回对话");
  await until(() => evaluate("window.api.answerRouting.list().then(r => r.length === 2)"), "saved from the actual answer");
  const rule = (await evaluate("window.api.answerRouting.list()")).find(item => item.id !== "dots-default-policy");
  assert.equal(rule.projectId, null);
  assert.equal(rule.sourceMemoryId, null);
  assert.equal(rule.evidenceFile, "release.md");
  await evaluate("import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setSettingsOpen(false))");

  await setMemory(true);
  checkInitial((await ask("both", both, question, "read")).answer);
  await setMemory(false);
  const first = await ask("routing-only", runTask, question, "read");
  checkInitial(first.answer);
  assert.equal(first.uses[0].evidence.contentHash, hash(original));
  assert.equal(JSON.stringify(first.calls[0].messages).split(original).length - 1, 1);
  await fs.writeFile(file, updated);

  // Send the second turn through the visible composer and capture its durable input id.
  await activate(runTask);
  await until(() => evaluate("!!document.querySelector('[data-routing-receipt=\"q-routing-only\"]')"), "first turn receipt");
  const composer = "textarea.input-textarea";
  await rpc("Page.bringToFront");
  await rpc("Emulation.setFocusEmulationEnabled", {enabled: true});
  await fill(composer, question);
  const send = 'button.send-btn[title="发送 (Enter)"]:not(:disabled)';
  await until(() => evaluate("!!document.querySelector(" + JSON.stringify(send) + ")"), "normal send action enabled");
  await evaluate("document.querySelector(" + JSON.stringify(send) + ").click()");
  let secondUse;
  await until(async () => {
    const rows = await evaluate("window.api.answerRouting.history()");
    secondUse = rows.find(r => r.taskId === runTask && !r.inputId.startsWith("q-"));
    if (!secondUse) return false;
    return evaluate("import('/src/store/appStore.ts').then(m=>{const t=m.useAppStore.getState().tasks.find(x=>x.id===" + JSON.stringify(runTask)
      + "); return t?.durable?.busy === false && t.durable.outcome === 'completed' && t.messages.filter(x=>x.role==='user').at(-1)?.inputRequestId === " + JSON.stringify(secondUse.inputId) + ";})");
  }, "updated release returned to the normal chat");
  await activate(runTask);
  const updatedReceipt = "[data-routing-receipt=" + JSON.stringify(secondUse.inputId) + "]";
  await until(() => evaluate("!!document.querySelector(" + JSON.stringify(updatedReceipt) + ")"), "updated reply has its own receipt");
  assert.equal(secondUse.evidence.contentHash, hash(updated));
  const latest = await evaluate("window.api.agent.loadTaskHistory(" + JSON.stringify(runTask) + ").then(h=>h.messages.at(-1).text)");
  assert(latest.split("\n").some(line=>line.includes("蓝桥") && /已(?:经)?上线/.test(line)), latest);
  assert.doesNotMatch(latest, /(?:纠正|更正|修正)上(?:一)?轮.{0,40}(?:错误|有误)/u);
  report.updatedTurn = {answer: latest, inputId: secondUse.inputId, contentHash: secondUse.evidence.contentHash};
  assert.deepEqual(await getUses(runTask, first.inputId), first.uses);
  const alternate = "帮我整理交付周报，列出蓝桥和青禾各自的编号和交付状态。";
  const paraphrase = await ask("alternate", runTask, alternate, "read");
  assert.equal(paraphrase.uses[0].evidence.contentHash, hash(updated));
  await fs.rename(file, path.join(home, "已移走.txt"));
  const missing = await ask("missing", runTask, question, "not-found");
  assert.match(missing.answer, /待核实|无法核实|未能核实|无法确认|待确认/);
  for (const project of ["蓝桥", "青禾"]) {
    const line = missing.answer.split("\n").find(row => row.includes(project));
    assert(line && /待核实|无法核实|未能核实|无法确认|待确认|暂无法|未核实/.test(line), missing.answer);
  }
  const translate = await ask("translation", runTask, "帮我翻译这份周报为英文：项目周报已整理。");
  assert.equal(translate.uses[0].ruleId, "dots-default-policy");
  assert.equal(await evaluate("window.api.answerRouting.preview(" + JSON.stringify(question) + ",null).then(r=>r?.rule.id)"), rule.id);

  await restart();
  await openSettings();
  for (const use of [secondUse, missing.uses[0], first.uses[0]]) {
    const selector = "button[data-routing-input=" + JSON.stringify(use.inputId) + "]";
    await until(() => evaluate("!!document.querySelector(" + JSON.stringify(selector) + ")"), "persisted turn " + use.inputId);
    await evaluate("document.querySelector(" + JSON.stringify(selector) + ").click()");
    const receipt = "[data-routing-receipt=" + JSON.stringify(use.inputId) + "]";
    await until(() => evaluate("!!document.activeElement?.matches('.message-list > div') && !!document.activeElement.querySelector(" + JSON.stringify(receipt) + ")"), "focused corresponding answer");
    await evaluate("document.querySelector(" + JSON.stringify(receipt) + ").click()");
    const graph = "document.getElementById(document.querySelector(" + JSON.stringify(receipt) + ").getAttribute('aria-controls'))";
    await until(() => evaluate("!!" + graph + "?.querySelector('[data-routing-graph=run]')"), "this answer's flow visible");
    const evidenceDetails = await evaluate(graph + ".querySelector('.routing-graph__details').textContent");
    assert(evidenceDetails.includes(use.evidence.contentHash || use.evidence.reason), evidenceDetails);
    if (use === first.uses[0]) await screenshot("turn-flow");
    await openSettings();
  }
  report.actualControlChecks.push("Taught from a real reply, saved the suggested source in the current project, asked again in the visible composer, and opened each original answer and flow after restart.");
}, { name: "answer-routing-live", liveModel: true, rpcTimeoutMs: 60000, settings: { memoryEnabled: true } });
