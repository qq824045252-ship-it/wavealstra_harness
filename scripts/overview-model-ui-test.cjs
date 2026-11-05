/**
 * overview-model-ui-test.cjs — 「概览」模型标识 UI 验收。
 *
 * 覆盖：主 Agent / 运行中子代理 / 完成态子代理都显示模型短标签；
 * title 保留完整 provider/model 与来源；窄面板下 chip 不溢出；
 * 运行中子代理行仍保持「点击打开临时 Chat」的既有行为。
 * 这是渲染器夹具验收（注入 IPC 数据 + Electron 截图），不等于打包应用验收。
 */
const { runRendererFixture } = require('./renderer-fixture-driver.cjs');
const { settleFramesScript } = require('./ui-capture.cjs');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');

const output = join(__dirname, '../out/tests');

runRendererFixture({ name: 'overview-model-ui', width: 420, height: 640 }, async (fixture) => {
  const evaluate = (code) => fixture.evaluate(code);
  const wait = async (code) => {
    const deadline = Date.now() + 5000;
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) throw new Error(`UI wait timed out: ${code}`);
      await new Promise((accept) => setTimeout(accept, 50));
    }
  };

  mkdirSync(output, { recursive: true });
  const html = join(output, 'overview-model-ui.html');
  writeFileSync(
    html,
    '<!doctype html><html lang="zh"><head><meta charset="UTF-8"><link rel="stylesheet" href="overview-model-ui.css"></head><body><div id="root"></div><script src="overview-model-ui.js"></script></body></html>',
  );
  await fixture.loadFile(html);

  // 主 Agent 1 + 运行中 3 + 完成态 1
  await wait(`document.querySelectorAll('.ro-model').length === 5`);

  const text = await evaluate('document.body.innerText');
  for (const expected of ['主 Agent', '代码审查', '资料检索', '测试 runner', 'DeepSeek V4.1 Flash · Open Design', 'GPT-5 · Codex', 'Claude Opus 4 · Claude']) {
    assert(text.includes(expected), `面板应显示「${expected}」`);
  }

  // 用户反馈的回归点：模型名放在智能体下方独立一行，完整展示（不被截断成「· 0…」）
  const mainLayout = await evaluate(
    `(()=>{const name=document.querySelector('.ro-row--main .ro-main-name').getBoundingClientRect();const chip=document.querySelector('.ro-row--main .ro-model').getBoundingClientRect();return { nameBottom:name.bottom, chipTop:chip.top, chipWidth:chip.width, chipScroll:document.querySelector('.ro-row--main .ro-model').scrollWidth, chipClient:document.querySelector('.ro-row--main .ro-model').clientWidth }})()`,
  );
  assert(mainLayout.chipTop >= mainLayout.nameBottom - 1, `主 Agent 模型名必须在名称下方一行（chipTop=${mainLayout.chipTop}, nameBottom=${mainLayout.nameBottom}）`);
  assert(mainLayout.chipScroll <= mainLayout.chipClient + 1, `完整模型名不得被截断（scroll=${mainLayout.chipScroll}, client=${mainLayout.chipClient}）`);

  const subLayout = await evaluate(
    `(()=>{const row=document.querySelector('.ro-list--subagents .ro-row');const name=row.querySelector('.ro-name').getBoundingClientRect();const chip=row.querySelector('.ro-model').getBoundingClientRect();const sub=row.querySelector('.ro-sub').getBoundingClientRect();return { nameBottom:name.bottom, chipTop:chip.top, chipBottom:chip.bottom, subTop:sub.top }})()`,
  );
  assert(subLayout.chipTop >= subLayout.nameBottom - 1, '运行中子代理的模型名在角色名下方一行');
  assert(subLayout.subTop >= subLayout.chipBottom - 1, '模型名位于角色名与工作摘要之间');

  const doneLayout = await evaluate(
    `(()=>{const row=document.querySelector('.ro-row--done');const head=row.querySelector('.ro-done-header').getBoundingClientRect();const chip=row.querySelector('.ro-model').getBoundingClientRect();return { headBottom:head.bottom, chipTop:chip.top }})()`,
  );
  assert(doneLayout.chipTop >= doneLayout.headBottom - 1, '完成态子代理的模型名在表头下方一行');

  const titles = await evaluate(`[...document.querySelectorAll('.ro-model')].map((el) => el.title)`);
  assert.equal(titles[0], '模型：deepseek/deepseek-v4.1-flash', '主 Agent title 保留完整模型 id');
  assert(
    titles.some((title) => title.includes('解析值 openai/gpt-5') && title.includes('来源：手动指定')),
    `子代理 title 同时给出解析值与来源（${titles.join(' | ')}）`,
  );
  assert(
    titles.some((title) => title.includes('来源：继承父模型')),
    '继承父模型的子代理也标出来源',
  );
  assert(
    titles.some((title) => title === '模型：openai/gpt-5'),
    '完成态子代理从证据行得到模型标签',
  );

  // 窄面板（348px 内容宽）：chip 不越界、不被压成 0 宽
  const boxes = await evaluate(
    `[...document.querySelectorAll('.ro-model')].map((el) => { const r = el.getBoundingClientRect(); return { width: r.width, left: r.left, right: r.right }; })`,
  );
  assert(boxes.every((box) => box.width > 0 && box.left >= 0 && box.right <= 420), `chip 必须完整落在面板内（${JSON.stringify(boxes)}）`);

  // 既有交互不变：点击运行中子代理行 → 打开临时 Chat
  await evaluate(`document.querySelector('.ro-list--subagents .ro-btn').click()`);
  await wait(`window.openedSubagent === 'sa-ui-1'`);

  await evaluate(settleFramesScript);
  await new Promise((accept) => setTimeout(accept, 100));
  await fixture.screenshot(join(output, 'overview-model-ui.png'));
});
