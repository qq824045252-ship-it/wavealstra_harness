const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

module.exports = async function checkWeatherTeaching(env) {
  const { evaluate, until, rpc, report } = env;
  const { press, click, fill, expand, openSettings, screenshot, askInChat } = routingControls(env);
  const { id: taskId } = await evaluate("window.api.dots.open()");
  const question = "今天天气怎么样";
  const method = "先读 weather.txt，用一句话写出文件里的站点代号和天气。缺资料就说待核实。";
  const source = "天气演练记录。站点代号 QH-672，晴。";
  await env.restart();
  await rpc("Emulation.setFocusEmulationEnabled", {enabled:true});
  await evaluate(`import('/src/store/appStore.ts').then(({useAppStore})=>{
    const store=useAppStore.getState(); store.setTheme('dark'); store.setSettingsOpen(false); return store.openDots();
  })`);
  const selector = css => "document.querySelector(" + JSON.stringify(css) + ")";
  const teach = '.message-list button[aria-label="下次这样答"]';
  const ask = text => askInChat(taskId, text);
  await ask("这是离线天气演练。接下来我问天气时，指的都是当前目录 weather.txt 里的模拟站点。请用该文件作答。现在只回复收到。");
  const {cwd} = await evaluate("window.api.dots.open()");
  const weatherFile = path.join(cwd, "weather.txt");
  await fs.writeFile(weatherFile, "天气演练记录。站点代号 LM-318，多云。");
  assert.equal((await ask(question)).uses.length, 0);
  await press(`[...document.querySelectorAll('${teach}')].at(-1)`, "teach from the weather reply");
  const instruction = 'textarea[aria-label="下次怎么做"]';
  assert.ok(await evaluate("!!document.querySelector('dialog.answer-rule-dialog:modal') && !document.querySelector('.desktop-settings')"));
  assert.equal(await evaluate(selector('[aria-label="遇到什么问题"]') + ".value"), question);
  assert.ok(await evaluate(selector(instruction) + ".checkVisibility()"));
  assert.equal(await evaluate("!!document.querySelector('.answer-rule-repair, .answer-routing [role=alert], .answer-routing [aria-label=测试匹配]')"), false);
  assert.equal(await evaluate("document.querySelectorAll('.answer-rule-form textarea').length"), 1);
  await press(selector(instruction), "teaching instruction");
  const before = env.requests.length;
  await rpc("Input.insertText", {text:method});
  assert.equal(await evaluate(selector('#answer-rule-file') + ".value"), "weather.txt");
  assert.equal(await evaluate(selector('#answer-rule-file') + ".checkVisibility()"), false);
  assert.match(await evaluate(selector(".answer-rule-config > summary") + ".innerText"), /先读 weather.txt/);
  await screenshot("weather-teaching");
  await rpc("Emulation.setDeviceMetricsOverride", {width:820, height:540, deviceScaleFactor:1, mobile:false});
  try {
    assert.ok(await evaluate(`(() => {
      const card = document.querySelector('.answer-rule-dialog'), save = card.querySelector('.answer-rule-save .primary');
      const r = save.getBoundingClientRect();
      return card.scrollWidth <= card.clientWidth && save.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    })()`), "save stays on screen at 820 × 540 without scrolling");
  } finally { await rpc("Emulation.clearDeviceMetricsOverride"); }
  await click("保存并返回对话");
  await until(() => evaluate("!document.querySelector('.answer-rule-form') && !!document.querySelector('textarea.input-textarea')"), "returned to chat");
  assert.match(await evaluate(selector(".answer-rule-confirmation") + ".textContent"), /已保存/);
  assert.equal(env.requests.length, before, "teaching and saving require no model call");
  await fs.writeFile(weatherFile, source);
  const digest = createHash("sha256").update(source).digest("hex");
  report.weatherTeaching = {question, method, expectedHash: digest, turns: []};
  let firstUse;
  for (const text of [question, "明天出门要带伞吗"]) {
    const {answer, uses} = await ask(text);
    assert.equal(uses.length, 1);
    assert.equal(uses[0].evidence?.status, "read");
    assert.equal(uses[0].evidence.contentHash, digest);
    assert.match(answer, /QH-672/);
    assert.match(answer, /晴/);
    report.weatherTeaching.turns.push({question:text, inputId:uses[0].inputId, revision:uses[0].revision, evidence:uses[0].evidence, answer});
    await until(() => evaluate(`!!document.querySelector('[data-routing-receipt="${uses[0].inputId}"]')`), "receipt beside the answer");
    if (!firstUse) {
      firstUse = uses[0];
      await press(`[...document.querySelectorAll('${teach}')].at(-1)`, "adjust the applied rule");
      await until(() => evaluate(selector(instruction) + ".value === " + JSON.stringify(method)), "previous instruction is editable");
      await fill(instruction, method + "只回复中文。");
      await click("更新规则并返回对话");
      await until(() => evaluate("!document.querySelector('dialog.answer-rule-dialog')"), "returned after updating");
    } else {
      assert.equal(uses[0].ruleId, firstUse.ruleId);
      assert.equal(uses[0].revision, firstUse.revision + 1);
    }
  }
  await screenshot("weather-answer");
  const translation = "把「今天天气怎么样」翻译成英文";
  const skipped = await ask(translation);
  assert.equal(skipped.uses.length, 0);
  report.weatherTeaching.turns.push({question:translation, uses:skipped.uses.length});
  await openSettings();
  await click("查询出行天气", ".answer-routing-list");
  await click("编辑");
  await fill('[aria-label="遇到什么问题"]', question);
  await expand("匹配问法与例外");
  await fill("#answer-rule-include", "航班");
  assert.ok(await evaluate("document.querySelector('.answer-rule-save .primary').disabled"));
  await click("把这句加入匹配问法");
  assert.equal(await evaluate("document.querySelector('.answer-rule-save .primary').disabled"), false);
  await click("取消");
  report.actualControlChecks.push("Typed the weather question in chat, taught one instruction, saved, repeated it, paraphrased it and asked for translation. Verified per-turn file receipts, answer contents and one-click conflict repair.");
};
