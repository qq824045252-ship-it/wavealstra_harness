import { app, BrowserWindow } from "electron";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { ArtifactPreviewHost } from "../src/main/artifact/ArtifactPreviewHost";
import { HtmlEditService } from "../src/main/html-edit/HtmlEditService";
import { EDIT_WORLD, editorRequest, editorSnapshot, editorUi } from "../src/main/html-edit/HtmlEditRuntime";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "mybuddy-html-edit-e2e-"));
app.setPath("userData", join(root, "profile"));
const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{font:18px system-ui;padding:40px;background:#faf8f4}p{padding:20px;border:1px solid #ddd;border-radius:10px}h1{font-size:28px}</style></head><body><h1>HTML 实时编辑测试</h1><p id="title">原始文案 <b>重点</b></p><p>可删除文案</p><p id="dynamic">动态文案</p><input id="value" value="2"><script>document.getElementById("dynamic").textContent="运行时结果";document.getElementById("value").value="99";</script></body></html>';
const file = join(root, "page.html"); writeFileSync(file, html);
const wait = (ms = 300) => new Promise(r => setTimeout(r, ms));
const timeout = setTimeout(() => { console.error("HTML editor test timed out"); app.exit(1); }, 90000);

type Ui = { active: boolean; selected: string | null; preview: boolean; aiOpen: boolean; patches: number; toolbarText: string; layoutRuns: number; controls: Record<string, { x: number; y: number; width: number; height: number; disabled?: boolean } | null> };
void (async () => {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1200, height: 900, show: false });
  await win.loadURL("data:text/html,<h2>MyBuddy HTML editor integration test</h2>");
  win.show();
  const browser = new BrowserHost(); browser.attach(win); browser.setBounds({ x: 10, y: 60, width: 1120, height: 780 });
  const loaded = new Promise<void>(r => browser.inspectionWebContents!.once("did-finish-load", () => r()));
  browser.open(pathToFileURL(file).href); await loaded; browser.show(); await wait();
  let saves = 0, aiCalls = 0;
  const service = new HtmlEditService({
    draftDir: join(root, "drafts"), exitCapture: () => browser.exitCapture(),
    resolve: () => browser.captureSurface!, contentSaved: () => { saves++; },
    ai: async (_model, _html, _instruction, signal) => { aiCalls++; await wait(180); if (signal.aborted) throw new Error("aborted"); return "AI 改写 <b>重点</b>"; },
  });
  const wc = browser.inspectionWebContents!;
  const iso = <T>(code: string) => wc.executeJavaScriptInIsolatedWorld(EDIT_WORLD, [{ code }], true) as Promise<T>;
  const snapshot = () => iso<any>(editorSnapshot());
  const ui = () => iso<Ui>(editorUi());
  const clickPoint = async (point: { x: number; y: number } | null | undefined) => { assert.ok(point); wc.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: Math.round(point!.x), y: Math.round(point!.y) }); wc.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: Math.round(point!.x), y: Math.round(point!.y) }); await wait(180); };
  const clickControl = async (name: string) => clickPoint((await ui()).controls[name]);
  const select = async (selector: string) => {
    const b = await wc.executeJavaScript(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(b.x+12),y:Math.round(b.y+12)}})()`);
    await clickPoint(b);
  };
  const selectAll = async () => { wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] }); wc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] }); await wait(50); };
  const start = async () => { const result = await service.start({ target: "browser", modelId: "test/model" }, win.webContents); assert.equal(result.ok, true, result.error); await wait(220); };

  await start();
  assert.equal(BrowserWindow.getAllWindows().filter(w => w.getTitle() === "MyBuddy HTML 编辑").length, 0, "editor must not open a second BrowserWindow");
  assert.equal((await ui()).active, true); assert.match((await ui()).toolbarText, /编辑.*AI.*保存.*完成/);
  const idleLayouts = (await ui()).layoutRuns; await wait(650); assert.ok((await ui()).layoutRuns - idleLayouts <= 1, "idle main-process polling must not keep forcing page layout");
  await select("#dynamic"); assert.equal((await snapshot()).selected, null, "runtime-mutated node is not source-editable");
  await select("#title"); { const selected = (await snapshot()).selected; const state = await ui(); const bold = state.controls.bold; assert.ok(selected, "native click selects source text"); assert.ok(bold && Math.abs(bold.y - (selected.y + selected.height / 2)) < 140, "toolbar stays close to selected text"); }
  await selectAll(); wc.insertText("手动输入文案"); await wait(520);
  assert.ok((await snapshot()).patches.some((p: { html: string }) => p.html.includes("手动输入文案")), "trusted native input becomes a draft");
  const draftFiles = readdirSync(join(root, "drafts")).filter(name => name.endsWith(".json")); assert.equal(draftFiles.length, 1, "debounced draft is persisted after typing settles");
  const draftPayload = JSON.parse(readFileSync(join(root, "drafts", draftFiles[0]), "utf8")); assert.equal(Object.prototype.hasOwnProperty.call(draftPayload, "source"), false, "draft must not duplicate the entire source HTML");
  await iso('window.__mybuddyHtmlEdit.command("undo")'); await select("#title"); await selectAll();
  await clickControl("bold"); assert.ok((await snapshot()).patches.length, "in-page toolbar formatting updates draft");

  await clickControl("ai"); assert.equal((await ui()).aiOpen, true, "AI prompt opens next to selection");
  await clickControl("aiInput"); wc.insertText("简化一点"); await clickControl("aiGo"); await wait(700);
  assert.equal(aiCalls, 1); assert.equal((await ui()).preview, true, "AI result previews in original position");
  assert.ok((await snapshot()).selected.html.includes("AI 改写"));
  await clickControl("acceptPreview"); await wait();
  assert.equal((await ui()).preview, false); assert.ok((await snapshot()).patches.some((p: { html: string }) => p.html.includes("AI 改写")));
  await clickControl("save"); await wait(900);
  assert.equal(saves, 1); const saved = readFileSync(file, "utf8"); assert.ok(saved.includes("AI 改写")); assert.ok(saved.includes('id="dynamic">动态文案')); assert.ok(saved.includes('value="2"')); assert.ok(!saved.includes("contenteditable")); assert.ok(readdirSync(root).some(f => f.includes(".bak_")));
  console.log("PASS in-page editor: no popup window, direct input, formatting, AI inline preview, source-safe save");

  await wait(400); await start(); await select("#title"); await selectAll(); wc.insertText("草稿恢复验证"); await wait();
  const draft = JSON.parse(JSON.stringify((await snapshot()).patches)); await service.stop(); await start();
  assert.deepEqual(JSON.parse(JSON.stringify((await snapshot()).patches)), draft, "exit/re-enter on same page restores draft"); await service.stop();
  console.log("PASS durable draft re-entry");

  browser.hide();
  const artifact = new ArtifactPreviewHost(); artifact.attach(win); artifact.setBounds({ x: 10, y: 60, width: 1120, height: 780 });
  await artifact.load(pathToFileURL(file).href); artifact.show();
  const service2 = new HtmlEditService({ draftDir: join(root, "artifact-drafts"), exitCapture: () => undefined, resolve: () => ({ ...artifact.captureSurface!, path: file, version: 1 }), contentSaved: () => { saves++; }, ai: async () => "proposal" });
  assert.equal((await service2.start({ target: "artifact", artifactId: "test", modelId: "test/model" }, win.webContents)).ok, true);
  const awc = artifact.captureSurface!.view.webContents;
  const aiso = <T>(code: string) => awc.executeJavaScriptInIsolatedWorld(EDIT_WORLD, [{ code }], true) as Promise<T>;
  const ab = await awc.executeJavaScript('(()=>{const r=document.querySelector("#title").getBoundingClientRect();return {x:Math.round(r.x+10),y:Math.round(r.y+10)}})()');
  awc.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...ab }); awc.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...ab }); await wait();
  awc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: ["control"] }); awc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] }); awc.insertText("产物原地编辑成功"); await wait();
  await aiso(editorRequest("save")); await wait(850); assert.equal(saves, 2); assert.ok(readFileSync(file, "utf8").includes("产物原地编辑成功")); artifact.hide();
  console.log("PASS artifact host uses the same in-page editor and source-safe commit");

  const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const address = server.address() as { port: number };
  const httpLoaded = new Promise<void>(r => wc.once("did-finish-load", () => r())); browser.open(`http://127.0.0.1:${address.port}/`); await httpLoaded; browser.show();
  const service3 = new HtmlEditService({ draftDir: join(root, "web-drafts"), exitCapture: () => undefined, resolve: () => browser.captureSurface!, contentSaved: () => { throw new Error("must not save HTTP source"); }, ai: async () => "proposal" });
  assert.equal((await service3.start({ target: "browser", modelId: "test/model" }, win.webContents)).ok, true); await wait();
  assert.equal((await ui()).controls.save?.disabled, true, "remote page save is visibly disabled"); await service3.stop(); server.close();
  console.log("PASS HTTP pages remain temporary-only");

  const db = new Database(":memory:"), repository = new ArtifactRepository(db), registry = new ArtifactRegistry(); let events = 0;
  const domain = new ArtifactService(new ArtifactStorage(join(root, "managed")), repository, registry, { updated: () => { events++; } });
  const registered = await domain.register({ taskId: "test-task", kind: "html", content: "<p>managed</p>" }); domain.notifyHtmlSaved(domain.entryPathOf(registered.id)!);
  assert.equal(domain.get(registered.id)!.version, 2); assert.equal(events, 1); db.close();
  console.log("PASS managed-content version and event publication");

  browser.dispose(); artifact.dispose(); win.destroy(); clearTimeout(timeout); app.exit(0);
})().catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
