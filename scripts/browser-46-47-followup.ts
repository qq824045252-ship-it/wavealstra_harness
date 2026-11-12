import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService, BrowserAutomationError, type BrowserExecInput } from "../src/main/capabilities/BrowserAutomationService";

const output = join(process.cwd(), "out/diagnostics/browser-46-47-followup");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, "electron-"));
app.setPath("userData", join(root, "profile"));
app.setPath("home", root);
app.on("window-all-closed", () => {});
const checks: string[] = [];
const mark = randomUUID();
const long = ("正文🙂中文\n".repeat(22000)) + mark;
const fixture = `<meta charset="utf-8"><title>Task fixture</title><label>姓名<input id="name"></label><label>备注<textarea id="notes"></textarea></label><div id="editor" aria-label="编辑器" contenteditable="true"></div><input id="readonly" readonly><input id="disabled" disabled><button id="save" onclick="document.body.dataset.submitted=JSON.stringify({name:document.querySelector('#name').value,notes:document.querySelector('#notes').value,editor:document.querySelector('#editor').textContent})">提交</button><button id="replace">替换</button><button>重复</button><button>重复</button><button id="covered" style="position:absolute;left:600px;top:150px">被遮挡</button><div style="position:absolute;left:590px;top:140px;width:150px;height:100px;z-index:9"></div><p id="clock"></p><div id="react-root"></div><script src="/react.js"></script><script>setInterval(()=>document.querySelector('#clock').textContent=Date.now(),30)</script>`;
const server = createServer((req, res) => {
  if (req.url === "/react.js") { res.setHeader("Content-Type", "application/javascript"); res.end(readFileSync("out/tests/browser-controlled-form-fixture.js")); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url === "/long" ? `<article style="white-space:pre-wrap">${long}</article>` : req.url === "/buttons" ? Array.from({ length: 120 }, (_, i) => `<button id="b${i}">按钮${i}</button>`).join("") : req.url === "/loading" ? "<p id='loading'>Loading...</p><script>setTimeout(()=>document.body.innerHTML='<main>数据完成</main>',200)</script>" : req.url === "/empty" ? "<body></body>" : req.url === "/frames" ? "<iframe src='/empty'></iframe><div id='shadow'></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>shadow-only</button>'</script>" : fixture);
});
let win: BrowserWindow | undefined, host: BrowserHost | undefined;
const guard = setTimeout(() => { console.error("browser task test timed out"); app.exit(1); }, 90_000);
const record = (name: string) => { checks.push(name); writeFileSync(join(output,"progress.json"),JSON.stringify(checks)); console.log("PASS", name); };
void (async () => {
  await app.whenReady();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  win = new BrowserWindow({ show: false, width: 1100, height: 850 });
  await win.loadURL("data:text/html,Isolated browser task regression");
  host = new BrowserHost(); host.attach(win);
  const browser = new BrowserAutomationService(() => host!);
  const a = { taskId: "task-a" }, b = { taskId: "task-b" };
  const closeProbe = await browser.execute({ action: "navigate", url: origin + "/empty?close" }, undefined, a); assert(closeProbe.tabId);
  const closing = host.getTabHost(closeProbe.tabId)!.inspectionWebContents!;
  const destroyed = new Promise<void>(resolve => closing.once("destroyed", resolve));
  host.closeTab(closeProbe.tabId); await destroyed;
  await assert.rejects(browser.execute({ action: "read", tabId: closeProbe.tabId }, undefined, a), error => error instanceof BrowserAutomationError && error.code === "PAGE_UNAVAILABLE");
  record("closed task tab never redirects to UI-selected page");
  const opened = await browser.execute({ action: "navigate", url: origin }, undefined, a); assert(opened.tabId);
  const page = host.getTabHost(opened.tabId)!; const wc = page.inspectionWebContents!;
  const other = await browser.execute({ action: "navigate", url: origin + "/empty" }, undefined, b); assert(other.tabId);
  host.selectTab(other.tabId);
  const run = (input: BrowserExecInput, signal?: AbortSignal) => browser.execute({ ...input, tabId: opened.tabId }, signal, a);
  await run({ action: "read" });
  await run({ action: "wait_for", selector: "#react", state: "attached" });
  for (const [selector, text] of [["#name", "林晨🙂"], ["#notes", "中文\n第二行"], ["#editor", "可编辑中文"], ["#react", "真实受控输入"]]) {
    await run({ action: "find", selector });
    await run({ action: "fill", selector, text });
  }
  await run({ action: "find", selector: "#save" });
  await run({ action: "click", selector: "#save" });
  assert.deepEqual(JSON.parse(await wc.executeJavaScript("document.body.dataset.submitted")), { name: "林晨🙂", notes: "中文\n第二行", editor: "可编辑中文" });
  await run({ action: "find", selector: "#react-save" }); await run({ action: "click", selector: "#react-save" });
  assert.equal(await wc.executeJavaScript("document.body.dataset.reactSubmitted"), "真实受控输入");
  assert.equal(host.activeTabId, other.tabId); assert.equal(win.isVisible(), false);
  record("background task fixed tab; trusted ordinary/textarea/contenteditable/React Chinese submission with unrelated DOM changes");

  for (const selector of ["#readonly", "#disabled", "#covered", "#reject"]) {
    await run({ action: "find", selector });
    await assert.rejects(run({ action: selector === "#covered" ? "click" : "fill", selector, text: "拒绝" }), error => error instanceof BrowserAutomationError);
  }
  record("readonly/disabled/occlusion/rejected controlled value are explicit failures");
  await run({ action: "find", selector: "#replace" });
  await wc.executeJavaScript("document.querySelector('#replace').outerHTML='<button id=replace>替换</button>'");
  await assert.rejects(run({ action: "click", selector: "#replace" }), error => error instanceof BrowserAutomationError && error.code === "SURFACE_CHANGED");
  await assert.rejects(run({ action: "click", role: "button", name: "重复" }), error => error instanceof BrowserAutomationError && error.code === "ELEMENT_AMBIGUOUS");
  record("node replacement rejected and semantic ambiguity explicit");

  await run({ action: "find", selector: "#save" });
  const submitted = await run({ action: "click", selector: "#save", timeoutMs: 300, after: { selector: "#never", mode: "text" } });
  assert.equal(submitted.outcome?.effect, "confirmed"); assert.equal(submitted.observation?.status, "failed");
  record("confirmed submission survives after-observation deadline");


  for (const mode of ["foreground", "minimized"] as const) {
    if (mode === "foreground") { win.showInactive(); host.selectTab(opened.tabId); host.setBounds({ x: 0, y: 0, width: 900, height: 700 }); }
    else { win.minimize(); await new Promise(r => setTimeout(r, 100)); }
    const expected = { name: mode+"姓名🙂", notes: mode+"中文\\n第二行", editor: mode+"可编辑中文" };
    for (const [selector,text] of [["#name",expected.name],["#notes",expected.notes],["#editor",expected.editor],["#react",mode+"受控中文"]]) {
      await run({action:"find",selector}); await run({action:"fill",selector,text});
    }
    await run({action:"find",selector:"#save"}); await run({action:"click",selector:"#save"});
    assert.deepEqual(JSON.parse(await wc.executeJavaScript("document.body.dataset.submitted")),expected);
    await run({action:"find",selector:"#react-save"}); await run({action:"click",selector:"#react-save"});
    assert.equal(await wc.executeJavaScript("document.body.dataset.reactSubmitted"),mode+"受控中文");
    for (const selector of ["#readonly","#disabled","#covered","#reject"]) {
      await run({action:"find",selector});
      await assert.rejects(run({action:selector==="#covered"?"click":"fill",selector,text:"拒绝"}),error=>error instanceof BrowserAutomationError);
    }
    if(mode==="minimized") assert(win.isMinimized(),"task must not restore window");
    record(mode+" full ordinary/textarea/contenteditable/React Chinese and readonly/disabled/covered/rejected matrix");
  }
  win.hide();
  // Execute actual finite renderer busy loops: no WebContents method replacement.
  for (const stopKind of ["abort","deadline","destroy"] as const) {
    const probe = await browser.execute({action:"navigate",url:origin+"/empty?busy="+stopKind},undefined,{taskId:"busy-"+stopKind});
    const busyWc=host.getTabHost(probe.tabId!)!.inspectionWebContents!;
    const busy=busyWc.executeJavaScript("(()=>{const until=Date.now()+1500;while(Date.now()<until){};return 'released'})()").catch(()=>null);
    await new Promise(r=>setTimeout(r,100));
    const ctrl=new AbortController();
    const began=Date.now();
    const pending=browser.execute({action:"read",tabId:probe.tabId!,timeoutMs:500},ctrl.signal,{taskId:"busy-"+stopKind});
    const checked=assert.rejects(pending,error=>error instanceof Error);
    setTimeout(()=>{ if(stopKind==="abort")ctrl.abort(); else if(stopKind==="destroy")host!.closeTab(probe.tabId!); },50);
    await checked;
    assert(Date.now()-began<1200,"caller must stop before renderer loop returns");
    if (stopKind !== "destroy") await busy;
    await browser.execute({action:"read",tabId:other.tabId!},undefined,b);
    record("actual busy renderer "+stopKind+" bounded; independent tab read succeeds");
  }

  const longTab = await browser.execute({ action: "navigate", url: origin + "/long" }, undefined, a); assert(longTab.tabId);
  let part = await browser.execute({ action: "read", tabId: longTab.tabId, mode: "text", maxChars: 10000 }, undefined, a);
  assert(part.textTruncated); assert.equal(part.elements, undefined);
  const pieces = [part.text!]; const staleCursor = part.nextCursor!;
  while (part.nextCursor) {
    part = await browser.execute({ action: "read", tabId: longTab.tabId, cursor: part.nextCursor, maxChars: 10000 }, undefined, a);
    assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text!)); pieces.push(part.text!);
  }
  assert.equal(pieces.join(""), long); assert.equal(part.textTotal, long.length);
  const longWc = host.getTabHost(longTab.tabId)!.inspectionWebContents!;
  await longWc.executeJavaScript("document.querySelector('article').append('changed')");
  await assert.rejects(browser.execute({ action: "read", tabId: longTab.tabId, cursor: staleCursor }, undefined, a), error => error instanceof BrowserAutomationError && error.code === "CURSOR_STALE");
  record("long text >100k Unicode complete continuation and stale-content rejection");

  const buttons = await browser.execute({ action: "navigate", url: origin + "/buttons" }, undefined, a); assert(buttons.tabId);
  let controls = await browser.execute({ action: "read", tabId: buttons.tabId, maxChars: 5000 }, undefined, a);
  const ids = controls.elements!.map(el => el.id);
  while (controls.nextCursor) { controls = await browser.execute({ action: "read", tabId: buttons.tabId, cursor: controls.nextCursor, maxChars: 5000 }, undefined, a); ids.push(...controls.elements!.map(el => el.id)); }
  assert.equal(ids.length, 120); assert.equal(new Set(ids).size, 120); assert.equal(ids.at(-1), "b119");
  const region = await browser.execute({ action: "read", tabId: buttons.tabId, selector: "#b119" }, undefined, a);
  assert.equal(region.text, "按钮119"); assert.equal(region.elements?.length, 1);
  record("120 targets paginated without omissions; selector-scoped read");

  const loaded = await browser.execute({ action: "navigate", url: origin + "/loading", after: { selector: "main", mode: "text" } }, undefined, a);
  assert.equal(loaded.observation?.status, "completed", JSON.stringify(loaded));
  const waited = await browser.execute({ action: "wait_for", selector: "main", after: { selector: "main", mode: "text" } }, undefined, a);
  assert(waited.observation?.status === "completed" && waited.observation.result.text === "数据完成");
  const empty = await browser.execute({ action: "navigate", url: origin + "/empty", after: { mode: "text" } }, undefined, a);
  assert(empty.observation?.status === "completed" && empty.observation.result.contentState === "empty");
  const frames = await browser.execute({ action: "navigate", url: origin + "/frames" }, undefined, a); assert(frames.tabId);
  const frameRead = await browser.execute({ action: "read", tabId: frames.tabId }, undefined, a);
  assert.equal(frameRead.coverage?.shadowDOM, "excluded"); assert(!frameRead.text?.includes("shadow-only"));
  await assert.rejects(browser.execute({ action: "read", tabId: frames.tabId, selector: "iframe" }, undefined, a), error => error instanceof BrowserAutomationError && error.code === "UNSUPPORTED_SCOPE");
  record("bounded async readiness, explicit empty and iframe support boundary");

  const [navA, navB] = await Promise.all([browser.execute({ action: "navigate", tabId: buttons.tabId, url: origin + "/empty?A" }, undefined, a), browser.execute({ action: "navigate", tabId: longTab.tabId, url: origin + "/empty?B" }, undefined, a)]);
  assert.equal(navA.tabId, buttons.tabId); assert.equal(navB.tabId, longTab.tabId);
  const abort = new AbortController();
  const original = longWc.executeJavaScript.bind(longWc);
  let readEntered!: () => void;
  const readStarted = new Promise<void>(resolve => { readEntered = resolve; });
  longWc.executeJavaScript = (() => { readEntered(); return new Promise(() => {}); }) as typeof longWc.executeJavaScript;
  const pending = browser.execute({ action: "read", tabId: longTab.tabId }, abort.signal, a);
  await readStarted;
  abort.abort(); await assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
  longWc.executeJavaScript = original;
  await browser.execute({ action: "read", tabId: buttons.tabId }, undefined, a);
  record("real Electron pending renderer cancel; independent tab remains usable");
  const originalDestroyed = new Promise<void>(resolve => wc.once("destroyed", resolve));
  host.closeTab(opened.tabId); await originalDestroyed;
  await assert.rejects(run({ action: "read" }), error => error instanceof BrowserAutomationError && error.code === "PAGE_UNAVAILABLE");
  record("closing a previously leased minimized page cleans native ownership");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  writeFileSync(join(output, "electron-results.json"), JSON.stringify({ checks, passed: !process.exitCode, electron: process.versions.electron, node: process.versions.node, profile: root }, null, 2));
  host?.dispose(); if (win && !win.isDestroyed()) win.destroy(); server.close(); clearTimeout(guard); app.exit(process.exitCode ? 1 : 0);
});




