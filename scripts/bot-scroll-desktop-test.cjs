// Actual BotWorkspacePage/store/Markdown in Chromium; controlled stream events.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-scroll-ui-'));
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
    const evaluate = code => win.webContents.executeJavaScript(code).catch(error=>{ console.error("Renderer expression:",code);throw error; });
    const settle = () => new Promise(r=>setTimeout(r,150));
    const wait = async code => { const end = Date.now()+8000; while (!await evaluate(code)) { if(Date.now()>end) throw Error('timeout: '+code); await new Promise(r=>setTimeout(r,40)); } };
    await wait('Boolean(window.concurrentFixture)');
    await evaluate('window.concurrentFixture.seedScroll()');
    await wait('document.querySelectorAll("[data-message-id]").length === 24');
    const distance = () => evaluate(`(()=>{const e=document.querySelector('.bot-thread');return e.scrollHeight-e.clientHeight-e.scrollTop})()`);
    const top = () => evaluate(`document.querySelector('.bot-thread').scrollTop`);
    await settle(); assert(await distance()<2,'initial restored history ends at newest, not the earliest streaming reply');
    await evaluate('window.concurrentFixture.streamScroll(19,"\\n\\n旧的并发回复追加内容\\n\\n".repeat(8))');
    await settle(); assert(await distance()<2,'older concurrent reply must not pull following viewport up to its own start');
    const bounds = await evaluate(`(()=>{const r=document.querySelector('.bot-thread').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    // Native wheel is intentionally only 20px: within the old 72px proximity
    // rule. A subsequent same-position scroll must not re-enable following.
    win.webContents.sendInputEvent({type:'mouseWheel',...bounds,deltaY:20,deltaX:0});
    await new Promise(r=>setTimeout(r,500));
    await wait(`Boolean(document.querySelector('.bot-latest-button'))`);
    const held = await top();
    await evaluate(`document.querySelector('.bot-thread').dispatchEvent(new Event('scroll')); window.concurrentFixture.streamScroll(23,'\\n\\n新回复继续输出\\n\\n'.repeat(12))`);
    await settle(); assert(Math.abs(await top()-held)<2,'small up-scroll remains owned by reader after output and redundant scroll');
    assert(await distance()>100,'output grows below reader without stealing viewport');
    // A pending frame cannot overtake an explicit PageUp gesture.
    await evaluate(`document.querySelector('.bot-latest-button').click()`); await settle();
    await evaluate(`window.concurrentFixture.streamScroll(23,'\\n\\n排队中的一帧');const e=document.querySelector('.bot-thread');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true}));e.scrollTop-=150;`);
    const keyboardTop = await top(); await settle(); assert(Math.abs(await top()-keyboardTop)<2,'queued frame respects intervening keyboard user intent');
    // Returning to the bottom is the explicit opt-in to resume streaming.
    await evaluate(`document.querySelector('.bot-latest-button').click()`); await settle();
    await evaluate(`window.concurrentFixture.streamScroll(23,'\\n\\n回到底部后继续\\n\\n'.repeat(10))`); await settle();
    assert(await distance()<2,'explicit latest resumes tail following');
    // ResizeObserver tracks delayed Markdown layout / viewport resize only in follow mode.
    win.setSize(800,700); await settle(); assert(await distance()<2,'following tracks resize');
    await evaluate(`(()=>{const e=document.querySelector('.bot-thread');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));e.scrollTop=100;})()`); await settle();
    await evaluate(`window.concurrentFixture.streamScroll(19,'\\n\\n较早回复已完成','completed');window.concurrentFixture.streamScroll(23,'\\n\\n最新回复已完成','completed')`); await settle();
    assert(Math.abs(await top()-100)<2,'completion and concurrent status updates do not move reader');
    await evaluate(`window.concurrentFixture.newScrollConversation()`); await settle();
    assert.equal(await top(),0,'new conversation resets old viewport');
    assert.equal(await evaluate(`Boolean(document.querySelector('.bot-latest-button'))`),false,'new conversation clears old detached-follow affordance');
    await evaluate(`window.concurrentFixture.seedScroll()`); await settle();
    assert(await distance()<2,'new conversation receives history with fresh following state');
    await evaluate(`(()=>{const e=document.querySelector('.bot-thread');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));e.scrollTop=100;window.concurrentFixture.switchScrollBot();})()`); await settle();
    assert.equal(await top(),0,'switch Bot cancels old scroll state');
    await evaluate(`window.concurrentFixture.seedScroll()`); await settle();
    assert(await distance()<2,'new Bot history follows independently');
    fs.writeFileSync(path.join(out,'bot-scroll-desktop.png'),await win.webContents.capturePage().then(image=>image.toPNG()));
    console.log('PASS Bot real Chromium: concurrent streams, small wheel up, redundant scroll, queued frame race, keyboard history, explicit resume, resize, completion, new conversation');
  } catch(error) { console.error(error); process.exitCode=1; }
  finally { win?.destroy(); app.exit(process.exitCode||0); }
});
