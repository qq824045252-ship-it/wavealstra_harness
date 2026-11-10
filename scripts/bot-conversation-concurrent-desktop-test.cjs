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
    for (const text of ['A 查天气', 'B 算术', 'C 写文档']) {
      await evaluate(`window.concurrentFixture.draft(${JSON.stringify(text)})`);
      await wait(`!document.querySelector('[aria-label="发送消息"]').disabled`);
      await evaluate(`document.querySelector('[aria-label="发送消息"]').click()`);
    }
    await wait('window.concurrentFixture.requests.length===3');
    assert.equal(await evaluate(`document.querySelector('textarea').value`), '');
    await evaluate('window.concurrentFixture.acknowledge(1);window.concurrentFixture.acknowledge(2);window.concurrentFixture.acknowledge(0)');
    await wait('!document.querySelector(".bot-pending-request")');
    await evaluate('window.concurrentFixture.answer(1,"B = 4",12,"completed");window.concurrentFixture.answer(0,"A 正在查",11,"running")');
    await wait('document.body.textContent.includes("B = 4") && document.body.textContent.includes("A 正在查")');
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
