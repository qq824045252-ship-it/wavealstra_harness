const assert = require("node:assert/strict");
const { run } = require("./desktop-dev-harness.cjs");

run(async ({ evaluate, until, report }) => {
  const click = label => evaluate(`(() => {
    const button = [...document.querySelectorAll('.answer-routing button')].find(item => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw Error('Missing/enabled control: ' + ${JSON.stringify(label)});
    button.click();
  })()`);
  const open = () => evaluate(`import('/src/store/appStore.ts').then(m => m.useAppStore.getState().setSettingsOpen(true, 'answerRouting'))`);
  await open();
  await until(() => evaluate("!!document.querySelector('.answer-routing')"), "settings tab visible");
  await click("查询出行天气示例");
  await click("保存规则");
  await until(() => evaluate("window.api.answerRouting.list().then(r => r.length === 1)"), "rule saved through settings");
  const ask = async query => {
    await evaluate(`(() => {
      const input = document.querySelector('[aria-label="试问内容"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)});
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
    await click("试问");
    await until(() => evaluate("!!document.querySelector('.answer-rule-result')"), "preview rendered");
    return evaluate("document.querySelector('.answer-rule-result').textContent");
  };
  assert.match(await ask("上海要带伞吗"), /查询出行天气/);
  assert.match(await ask("润色这段天气提醒"), /没有匹配规则/);
  await evaluate("document.querySelector('[aria-label=启用查询出行天气]').click()");
  await until(() => evaluate("window.api.answerRouting.list().then(r => !r[0].enabled)"), "disabled rule persisted");
  assert.match(await ask("上海要带伞吗"), /没有匹配规则/);
  const memory = await evaluate(`window.api.memory.create({kind:'procedure', title:'交付核对', content:'交付前核对签收凭据', scopeType:'global', sourceType:'manual'})`);
  await evaluate(`import('/src/store/appStore.ts').then(m => m.useAppStore.getState().setSettingsOpen(true, 'memory'))`);
  const memoryButton = label => `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)}))`;
  await until(() => evaluate(`!!(${memoryButton("交付核对")})`), "global memory shown");
  await evaluate(`(${memoryButton("交付核对")}).click()`);
  await until(() => evaluate(`!!(${memoryButton("设为回答规则")})`), "promote action available");
  await evaluate(`(${memoryButton("设为回答规则")}).click()`);
  await until(() => evaluate("!!document.querySelector('.answer-rule-form')"), "memory-backed rule editor");
  assert.equal(await evaluate("document.querySelector('label textarea[maxlength=\"2000\"]').value"), "交付前核对签收凭据");
  await evaluate(`(() => {
    const field = document.querySelector('input[placeholder="多个短语用逗号分隔"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field,'交付报告');
    field.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await click("保存规则");
  await until(() => evaluate("window.api.answerRouting.list().then(r => r.length === 2)"), "promoted memory saved");
  assert.equal(await evaluate("window.api.answerRouting.list().then(r => r[0].sourceMemoryId)"), memory.id);
  assert.match(await ask("生成交付报告"), /交付核对/);
  report.actualControlChecks.push("Settings save, positive and negative previews, disable, global memory promotion and linked rule preview");
}, { name: "answer-routing", settings: { memoryEnabled: true } });
