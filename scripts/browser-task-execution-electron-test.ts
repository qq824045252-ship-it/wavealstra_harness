import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService, BrowserAutomationError, type BrowserExecInput } from "../src/main/capabilities/BrowserAutomationService";

const output = join(process.cwd(), "out/diagnostics/browser-46-50");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, "electron-"));
app.setPath("userData", join(root, "profile"));
app.setPath("home", root);
app.on("window-all-closed", () => {});
const checks: string[] = [];
const mark = randomUUID();
const realGadgetDirectory = process.env.BROWSER_GADGET_FIXTURE_DIR;
const long = ("正文🙂中文\n".repeat(22000)) + mark;
const fixture = `<meta charset="utf-8"><title>Task fixture</title><label>姓名<input id="name"></label><label>备注<textarea id="notes"></textarea></label><div id="editor" aria-label="编辑器" contenteditable="true"></div><input id="readonly" readonly><input id="disabled" disabled><button id="save" onclick="document.body.dataset.submitted=JSON.stringify({name:document.querySelector('#name').value,notes:document.querySelector('#notes').value,editor:document.querySelector('#editor').textContent})">提交</button><button id="replace">替换</button><button>重复</button><button>重复</button><button id="covered" style="position:absolute;left:600px;top:150px">被遮挡</button><div style="position:absolute;left:590px;top:140px;width:150px;height:100px;z-index:9"></div><p id="clock"></p><div id="react-root"></div><script src="/react.js"></script><script>setInterval(()=>document.querySelector('#clock').textContent=Date.now(),30)</script>`;
const actionsFixture = `<meta charset="utf-8"><title>Browser actions</title><style>html{scroll-behavior:smooth}button{padding:12px}#menu{display:none}#hover:hover #menu{display:block}#books-group{position:relative;width:140px}#book-items{display:none;position:absolute;left:130px;top:0;background:white;z-index:30;width:200px}#books-group:hover #book-items{display:block}</style>
<div id="books-group"><button id="books">账簿</button><div id="book-items"><a id="voucher" href="/report">凭证汇总表</a></div></div>
<button id="enter" onclick="window.enterCount=(window.enterCount||0)+1">按键提交</button>
<label>地区<select id="region" onchange="window.region=this.value"><option value="cn">中国</option><option value="jp">日本</option><option value="disabled" disabled>禁用项</option></select></label>
<select id="multi" multiple aria-label="多选"><option value="a">甲</option><option value="b">乙</option><option value="c">丙</option></select>
<label><input id="check" type="checkbox" onclick="window.checkCount=(window.checkCount||0)+1">同意</label>
<fieldset disabled><button id="fieldset-button">禁用组按钮</button></fieldset>
<div id="hidden-parent" style="opacity:0"><button id="hidden-child" onclick="window.hiddenClicked=true">隐藏子项</button></div>
<div id="hover" style="width:200px" aria-label="悬停菜单" role="button">菜单<button id="menu" onclick="window.menuClicked=true">子菜单</button></div>
<button id="partial" style="position:absolute;left:450px;top:240px;width:200px;height:60px" onclick="window.partialClicked=true">部分遮挡</button><div style="position:absolute;left:530px;top:255px;width:40px;height:30px;z-index:9"></div>
<div id="scroller" role="region" aria-label="滚动列表" style="margin-top:100px;height:150px;width:250px;overflow:auto;overscroll-behavior:contain"><div style="height:1200px">长列表</div></div>
<div style="height:1800px"></div><button id="far" onclick="window.farClicked=true">屏外按钮</button>`;
let reportRequests = 0;
const server = createServer((req, res) => {
  if (req.url === "/react.js") { res.setHeader("Content-Type", "application/javascript"); res.end(readFileSync("out/tests/browser-controlled-form-fixture.js")); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (realGadgetDirectory && req.url === "/real-gadget/index.html") { res.end(readFileSync(join(realGadgetDirectory, "index.html"))); return; }
  if (realGadgetDirectory && req.url?.startsWith("/real-gadget/data.json?")) { res.setHeader("Content-Type", "application/json"); res.end(readFileSync(join(realGadgetDirectory, "data.json"))); return; }
  if (req.url === "/actions") { res.end(actionsFixture); return; }
  if (req.url === "/disclosure") { res.end(`<style>#submit>summary::after{content:'展开指令'}</style><input id="capInput" placeholder="一句话"><details id="submit"><summary><span>3</span> 项待提交 · 尚未写入 Google</summary><div><button id="copyBtn" onclick="window.copyCount=(window.copyCount||0)+1">复制指令</button><details id="nested"><summary>更多选项</summary><button id="nested-action">内部操作</button></details></div></details>`); return; }
  if (req.url === "/report") { reportRequests++; setTimeout(() => res.end("<main>凭证汇总表<table><tr><th>科目</th><th>借方</th><th>贷方</th></tr><tr><td>银行存款</td><td>100</td><td>0</td></tr></table></main>"), 200); return; }
  res.end(req.url === "/long" ? `<article style="white-space:pre-wrap">${long}</article>` : req.url === "/buttons" ? Array.from({ length: 120 }, (_, i) => `<button id="b${i}">按钮${i}</button>`).join("") : req.url === "/loading" ? "<p id='loading'>Loading...</p><script>setTimeout(()=>document.body.innerHTML='<main>数据完成</main>',200)</script>" : req.url === "/empty" ? "<body></body>" : req.url === "/frames" ? "<iframe src='/empty'></iframe><div id='shadow'></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>shadow-only</button>'</script>" : fixture);
});
let win: BrowserWindow | undefined, host: BrowserHost | undefined;
const guard = setTimeout(() => { console.error("browser task test timed out"); app.exit(1); }, 90_000);
const record = (name: string) => { checks.push(name); console.log("PASS", name); };
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

  const disclosure = await browser.execute({ action: "navigate", url: origin + "/disclosure", after: { mode: "interactive" } }, undefined, a); assert(disclosure.tabId);
  const disclose = (input: BrowserExecInput) => browser.execute({ ...input, tabId: disclosure.tabId }, undefined, a);
  assert(disclosure.observation?.status === "completed");
  const summary = disclosure.observation.result.elements?.find(el => el.tag === "summary");
  assert(summary, "interactive observation must include native summary controls");
  assert.equal(summary.role, "button"); assert.equal(summary.expanded, false);
  assert(!disclosure.observation.result.elements?.some(el => el.id === "copyBtn"), "closed details content must not be advertised as visible");
  const summaries = await disclose({ action: "find", role: "button", name: "项待提交" });
  assert.equal(summaries.elements?.length, 1);
  const hiddenCopy = await disclose({ action: "inspect", selector: "#copyBtn" });
  assert.equal(hiddenCopy.elements?.[0].visible, false);
  const hiddenBy = hiddenCopy.elements?.[0].hiddenBy;
  assert.equal(hiddenBy?.kind, "details"); assert.equal(hiddenBy?.label, "3 项待提交 · 尚未写入 Google");
  assert(hiddenBy);
  const nested = await disclose({ action: "inspect", selector: "#nested-action" });
  assert.equal(nested.elements?.[0].hiddenBy?.selector, hiddenBy.selector, "suggest the outermost closed disclosure first");
  await disclose({ action: "click", selector: hiddenBy.selector });
  await disclose({ action: "click", selector: "#copyBtn" });
  const disclosureWc = host.getTabHost(disclosure.tabId)!.inspectionWebContents!;
  assert.equal(await disclosureWc.executeJavaScript("window.copyCount"), 1);
  const expandedSummary = await disclose({ action: "find", selector: "#submit>summary" });
  assert.equal(expandedSummary.elements?.[0].expanded, true);
  const nestedAfter = await disclose({ action: "inspect", selector: "#nested-action" });
  assert.equal(nestedAfter.elements?.[0].hiddenBy?.label, "更多选项");
  record("native summary role, expanded state, closed-details visibility and observed expansion control");

  if (realGadgetDirectory) {
    const realSource = readFileSync(join(realGadgetDirectory, "index.html"), "utf8");
    const outboxKey = /const OUTBOX_KEY = '([^']+)'/.exec(realSource)?.[1];
    assert(outboxKey, "the requested Gadget fixture must expose its outbox storage key");
    await disclosureWc.executeJavaScript(`localStorage.setItem(${JSON.stringify(outboxKey)},JSON.stringify([{type:'note.create',text:'isolated browser regression'}]))`);
    const realGadget = await browser.execute({ action: "navigate", url: origin + "/real-gadget/index.html", after: { selector: "#submit>summary", state: "visible", mode: "interactive" } }, undefined, a);
    assert(realGadget.tabId); assert.equal(realGadget.observation?.status, "completed");
    const realRun = (input: BrowserExecInput) => browser.execute({ ...input, tabId: realGadget.tabId }, undefined, a);
    const realSummary = await realRun({ action: "find", role: "button", name: "项待提交" });
    assert.equal(realSummary.elements?.length, 1); assert.equal(realSummary.elements?.[0].expanded, false);
    const realCopy = await realRun({ action: "inspect", selector: "#copyBtn" });
    assert.equal(realCopy.elements?.[0].visible, false); assert(realCopy.elements?.[0].hiddenBy);
    await realRun({ action: "click", selector: realCopy.elements[0].hiddenBy.selector });
    const copyReady = await realRun({ action: "wait_for", selector: "#copyBtn", state: "visible" });
    assert.equal(copyReady.elements?.[0].visible, true);
    await realRun({ action: "find", selector: "#capInput" });
    const realFilled = await realRun({ action: "fill", selector: "#capInput", text: "检查浏览器观察" });
    assert.equal(realFilled.outcome?.effect, "confirmed");
    assert.equal(host.activeTabId, other.tabId);
    record("original three-in-one Gadget source: semantic disclosure, hidden copy control and capture input on an isolated profile");
  }

  await run({ action: "find", selector: "#save" });
  const submitted = await run({ action: "click", selector: "#save", timeoutMs: 300, after: { selector: "#never", mode: "text" } });
  assert.equal(submitted.outcome?.effect, "confirmed"); assert.equal(submitted.observation?.status, "failed");
  record("confirmed submission survives after-observation deadline");

  const actions = await browser.execute({ action: "navigate", url: origin + "/actions" }, undefined, a); assert(actions.tabId);
  const actionWc = host.getTabHost(actions.tabId)!.inspectionWebContents!;
  const navigationTrace: unknown[] = [];
  let tracingNavigation = false;
  const trace = (stage: string) => { if (tracingNavigation) navigationTrace.push({ stage, time: Date.now(), url: actionWc.getURL(), version: host!.getTabHost(actions.tabId!)?.captureVersion }); };
  actionWc.on("did-start-navigation", () => trace("did-start-navigation"));
  actionWc.on("did-start-loading", () => trace("did-start-loading"));
  actionWc.on("did-navigate", () => trace("did-navigate"));
  actionWc.on("dom-ready", () => trace("dom-ready"));
  actionWc.on("did-stop-loading", () => trace("did-stop-loading"));
  const act = (input: BrowserExecInput, signal?: AbortSignal) => browser.execute({ ...input, tabId: actions.tabId }, signal, a);
  await act({ action: "read" });
  await act({ action: "press", selector: "#enter", key: "Enter" });
  assert.equal(await actionWc.executeJavaScript("window.enterCount"), 1, "press must not click before Enter");
  await act({ action: "click", selector: "#partial" });
  assert.equal(await actionWc.executeJavaScript("window.partialClicked"), true);
  await act({ action: "find", selector: "#hidden-child" });
  await assert.rejects(act({ action: "click", selector: "#hidden-child" }), error => error instanceof BrowserAutomationError && error.code === "ELEMENT_NOT_VISIBLE" && (error.details as { outcome?: { dispatch: string } }).outcome?.dispatch === "not_started");
  assert.equal(await actionWc.executeJavaScript("window.hiddenClicked"), undefined);
  await actionWc.executeJavaScript("setTimeout(()=>document.querySelector('#hidden-parent').style.opacity='1',200)");
  await act({ action: "click", selector: "#hidden-child" });
  assert.equal(await actionWc.executeJavaScript("window.hiddenClicked"), true);
  await act({ action: "find", selector: "#fieldset-button" });
  await assert.rejects(act({ action: "click", selector: "#fieldset-button" }), error => error instanceof BrowserAutomationError && error.code === "ELEMENT_DISABLED");
  record("Enter fires once; partial occlusion, ancestor opacity, transient visibility and disabled fieldsets");

  await act({ action: "find", selector: "#region" });
  const inspected = await act({ action: "inspect", selector: "#region" });
  assert.equal(inspected.elements?.[0].options?.[2].disabled, true);
  assert(inspected.elements?.[0].bounds); assert(inspected.elements?.[0].outerHTML?.includes("select"));
  await assert.rejects(act({ action: "select", selector: "#region", values: ["disabled"] }), error => error instanceof BrowserAutomationError && error.code === "ELEMENT_NOT_EDITABLE");
  const selected = await act({ action: "select", selector: "#region", values: ["jp"], after: { mode: "text" } });
  assert.equal(selected.outcome?.effect, "confirmed"); assert.equal(selected.observation?.status, "completed");
  assert.equal(await actionWc.executeJavaScript("window.region"), "jp");
  await act({ action: "find", selector: "#multi" });
  await act({ action: "select", selector: "#multi", values: ["a", "c"] });
  assert.deepEqual(await actionWc.executeJavaScript("Array.from(document.querySelector('#multi').selectedOptions,o=>o.value)"), ["a", "c"]);
  await act({ action: "select", selector: "#multi", values: [] });
  assert.equal(await actionWc.executeJavaScript("document.querySelector('#multi').selectedOptions.length"), 0);
  await act({ action: "find", selector: "#check" });
  await act({ action: "check", selector: "#check", checked: true });
  const already = await act({ action: "check", selector: "#check", checked: true });
  assert.equal(already.outcome?.dispatch, "not_started");
  assert.equal(await actionWc.executeJavaScript("window.checkCount"), 1);
  await act({ action: "check", selector: "#check", checked: false });
  assert.equal(await actionWc.executeJavaScript("document.querySelector('#check').checked"), false);
  record("inspected options and geometry; single/multiple select; idempotent checked state with real page events");

  await act({ action: "find", selector: "#hover" });
  await act({ action: "hover", selector: "#hover", after: { selector: "#menu", state: "visible" } });
  await act({ action: "find", selector: "#menu" });
  await act({ action: "click", selector: "#menu" });
  assert.equal(await actionWc.executeJavaScript("window.menuClicked"), true);
  await act({ action: "find", selector: "#scroller" });
  await act({ action: "scroll", selector: "#scroller", deltaY: 300 });
  assert(await actionWc.executeJavaScript("document.querySelector('#scroller').scrollTop>0"));
  await act({ action: "scroll", deltaY: 400 });
  assert(await actionWc.executeJavaScript("scrollY>0"));
  await act({ action: "find", selector: "#far" });
  await act({ action: "click", selector: "#far" });
  assert.equal(await actionWc.executeJavaScript("window.farClicked"), true);
  assert.equal(host.activeTabId, other.tabId);
  record("hover menu, nested and viewport trusted wheel input, instant offscreen click despite smooth CSS, task isolation");

  await act({ action: "find", selector: "#voucher" });
  await assert.rejects(act({ action: "click", selector: "#voucher", timeoutMs: 300 }), error => error instanceof BrowserAutomationError && error.code === "ELEMENT_NOT_VISIBLE");
  for (let iteration = 0; iteration < 3; iteration++) {
    if (iteration) await act({ action: "navigate", url: origin + "/actions", after: { mode: "interactive" } });
    tracingNavigation = true; navigationTrace.length = 0; trace("flyout-start");
    const reportPage = await act({ action: "click", selector: "#voucher", hover: [{ role: "button", name: "账簿" }], after: { selector: "main", mode: "text" } });
    trace("flyout-return"); tracingNavigation = false;
    writeFileSync(join(root, `navigation-${iteration}.json`), JSON.stringify({ premise: "afterObservation's loading check already describes the click's destination document", reportPage, navigationTrace }, null, 2));
    if (reportPage.observation?.status !== "completed") console.error("navigation-trace", JSON.stringify(navigationTrace));
    assert.equal(reportPage.outcome?.effect, "confirmed");
    assert.equal(reportPage.sourceUrl, origin + "/actions");
    assert(reportPage.observation?.status === "completed", JSON.stringify(reportPage.observation));
    assert.match(reportPage.observation.result.text ?? "", /科目\t借方\t贷方/);
    assert.equal(actionWc.getURL(), origin + "/report");
    assert.equal(host.activeTabId, other.tabId);
  }
  assert.equal(reportRequests, 3, "document changes during after-observation must not replay the link click");
  record("collapsed flyout opens and navigates in one hover-path click without changing the user's selected tab");

  for (const mode of ["foreground", "minimized"] as const) {
    if (mode === "foreground") { win.showInactive(); host.selectTab(opened.tabId); host.setBounds({ x: 0, y: 0, width: 900, height: 700 }); }
    else win.minimize();
    await run({ action: "find", selector: "#name" }); await run({ action: "fill", selector: "#name", text: mode + "中文" });
    await run({ action: "find", selector: "#save" }); await run({ action: "click", selector: "#save" });
    assert.equal(JSON.parse(await wc.executeJavaScript("document.body.dataset.submitted")).name, mode + "中文");
    if (mode === "minimized") assert(win.isMinimized(), "task must not restore the user's window");
    record(`${mode} real input submission`);
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
  await assert.rejects(browser.execute({ action: "read", tabId: buttons.tabId, maxChars: 1000 }, undefined, a), error => error instanceof BrowserAutomationError && error.code === "READ_LIMIT", "an undersized metadata budget must not return a cursor that makes no progress");

  const loaded = await browser.execute({ action: "navigate", url: origin + "/loading", after: { selector: "main", mode: "text" } }, undefined, a);
  assert.equal(loaded.observation?.status, "completed", JSON.stringify(loaded));
  const waited = await browser.execute({ action: "wait_for", selector: "main", after: { selector: "main", mode: "text" } }, undefined, a);
  assert(waited.observation?.status === "completed" && waited.observation.result.text === "数据完成");
  const empty = await browser.execute({ action: "navigate", url: origin + "/empty", after: { mode: "text" } }, undefined, a);
  assert(empty.observation?.status === "completed" && empty.observation.result.contentState === "empty");
  const frames = await browser.execute({ action: "navigate", url: origin + "/frames" }, undefined, a); assert(frames.tabId);
  const frameRead = await browser.execute({ action: "read", tabId: frames.tabId }, undefined, a);
  assert.equal(frameRead.coverage?.shadowDOM, "open"); assert(frameRead.text?.includes("shadow-only"));
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
