const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-concurrent-ui-'));
app.setPath('userData', path.join(profile, 'chromium'));
app.whenReady().then(async () => {
  let win;
  try {
    const out = path.resolve('out/tests');
    const html = path.join(profile, 'fixture.html');
    const url = suffix => pathToFileURL(path.join(out, `bot-conversation-concurrent-desktop-fixture.${suffix}`)).href;
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${url('css')}"><style>body{margin:0;font:14px system-ui}*{box-sizing:border-box}:root{--fg:#222;--fg-secondary:#555;--fg-muted:#777;--bg-panel:#fafafa;--bg-elevated:#fff;--border-default:#ddd;--border-subtle:#ddd;--accent:#2563eb}#root,.bot-workspace{height:100vh}</style></head><body><div id="root"></div><script src="${url('js')}"></script></body></html>`);
    win = new BrowserWindow({ width: 1050, height: 820, show: true, webPreferences: { contextIsolation: true } });
    await win.loadFile(html);
    const evaluate = code => win.webContents.executeJavaScript(code);
    const wait = async code => { const end = Date.now()+8000; while (!await evaluate(code)) { if(Date.now()>end) throw Error('timeout: '+code); await new Promise(r=>setTimeout(r,40)); } };
    await wait('Boolean(window.concurrentFixture)');
    await wait(`!document.querySelector('[aria-label="选择 Bot 模型"]').disabled`);
    assert.equal(await evaluate(`Boolean(document.querySelector('[aria-label="增强提示词"]'))`),false,'empty draft hides enhance');
    await evaluate(`document.querySelector('[aria-label="选择 Bot 模型"]').click()`);
    await wait(`document.querySelector('[aria-label="Bot 模型列表"]')`);
    await evaluate(`[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.includes('Model B')).click()`);
    await evaluate(`window.concurrentFixture.draft('请优化这句话')`);
    await wait(`document.querySelector('[aria-label="增强提示词"]')`);
    await evaluate(`document.querySelector('[aria-label="增强提示词"]').click()`);
    await wait(`document.querySelector('[aria-label="增强中…"]')`);
    await evaluate(`window.concurrentFixture.resolveEnhance('优化后的输入')`);
    await wait(`document.querySelector('textarea').value==='优化后的输入'`);
    await evaluate(`document.querySelector('[aria-label="恢复原文"]').click()`);
    await wait(`document.querySelector('textarea').value==='请优化这句话'`);
    for (const [category, item] of [['专家','Fixture expert'],['技能','Fixture skill'],['MCP','fixture-mcp']]) {
      await evaluate(`document.querySelector('[aria-label="添加"]').click()`);
      await wait(`document.querySelector('.add-menu')`);
      await evaluate(`[...document.querySelectorAll('.add-menu-item')].find(e=>e.textContent.trim()===${JSON.stringify(category)}).click()`);
      await wait(`[...document.querySelectorAll('.add-menu-flyout-item')].some(e=>e.textContent.includes(${JSON.stringify(item)}))`);
      await evaluate(`[...document.querySelectorAll('.add-menu-flyout-item')].find(e=>e.textContent.includes(${JSON.stringify(item)})).click()`);
    }
    await evaluate(`document.querySelector('[aria-label="添加"]').click()`);
    await evaluate(`[...document.querySelectorAll('.add-menu-item')].find(e=>e.textContent.trim()==='连接器').click()`);
    await wait(`document.querySelector('.add-menu-connect-btn')`);
    await evaluate(`document.querySelector('.add-menu-connect-btn').click()`);
    for (const text of ['A 查天气', 'B 算术', 'C 写文档']) {
      await evaluate(`window.concurrentFixture.draft(${JSON.stringify(text)})`);
      await wait(`!document.querySelector('[aria-label="发送消息"]').disabled`);
      await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`);
    }
    await wait('window.concurrentFixture.requests.length===3');
    assert.equal(await evaluate(`document.querySelector('textarea').value`), '');
    assert.deepEqual(await evaluate('window.concurrentFixture.requests[0].selection'),{modelId:'model-b',expertId:'fixture-expert',skillIds:['fixture-skill'],mcpIds:['fixture-mcp'],connectorIds:['fixture-connector']});
    await evaluate('window.concurrentFixture.acknowledge(1);window.concurrentFixture.acknowledge(2);window.concurrentFixture.acknowledge(0)');
    await wait('!document.querySelector(".bot-pending-request")');
    await evaluate('window.concurrentFixture.answer(1,"B = 4",12,"completed");window.concurrentFixture.answer(0,"A 正在查",11,"running")');
    await wait('document.body.textContent.includes("B = 4") && document.body.textContent.includes("A 正在查")');
    await evaluate('window.concurrentFixture.setMetrics(0,100000);window.concurrentFixture.setMetrics(1,900000)');
    await wait(`document.querySelectorAll('.bot-reply-metrics')[0].textContent.includes('输入 0.1M')`);
    assert(await evaluate(`document.querySelectorAll('.bot-reply-metrics')[1].textContent.includes('输入 0.9M')`));
    assert(await evaluate(`document.querySelectorAll('.bot-reply-metrics')[1].textContent.includes('平均 40.0 tok/s')`));
    assert(await evaluate(`document.querySelectorAll('.bot-reply-metrics')[2].textContent.includes('输入 —')`));
    const refs = await evaluate(`[...document.querySelectorAll('.bot-reply-reference')].map(e=>e.textContent)`);
    assert.deepEqual(refs, ['回复：A 查天气','回复：B 算术','回复：C 写文档']);
    await evaluate(`[...document.querySelectorAll('.bot-message.assistant')][2].querySelector('.bot-message-meta button:last-child').click()`);
    await wait('window.concurrentFixture.cancellations.length===1');
    assert(await evaluate('window.concurrentFixture.cancellations[0]===window.concurrentFixture.requests[2].requestId'));
    assert.equal(await evaluate(`document.querySelectorAll('[data-streaming="true"]').length`),1);
    await evaluate(`document.querySelector('.bot-message.user .bot-message-meta button').click();window.concurrentFixture.draft('补充杭州')`);
    await wait(`!document.querySelector('[aria-label="发送消息"]').disabled`);
    await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`);
    await wait('window.concurrentFixture.requests.length===4');
    assert(await evaluate('window.concurrentFixture.requests[3].referenceMessageId === "u-"+window.concurrentFixture.requests[0].requestId'));
    fs.writeFileSync(path.join(out,'bot-conversation-concurrent-desktop.png'),await win.webContents.capturePage().then(image=>image.toPNG()));
    console.log('PASS real Chromium page/store: 3 unacknowledged sends, reverse acknowledgements, out-of-order streams, stable question association, isolated stop, reference followup');
  } catch(error) { console.error(error); process.exitCode=1; }
  finally { win?.destroy(); app.exit(process.exitCode||0); }
});
