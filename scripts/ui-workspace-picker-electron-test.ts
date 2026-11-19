import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { build } from "esbuild";
import { Value } from "typebox/value";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { setUiAutomationMainWindow } from "../src/main/capabilities/UiAutomationService";
import { isDangerousTool, isSideEffectTool } from "../src/shared/pi-event-mapper";

const root = mkdtempSync(join(tmpdir(), "ui-workspace-picker-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
app.setPath("userData", join(root, "profile"));
app.setPath("home", root);
const guard = setTimeout(() => { console.error("workspace picker fixture timed out"); app.exit(1); }, 45000);

async function run(): Promise<void> {
  await app.whenReady();
  const fixture = "scripts/gadget-save-copies-desktop-fixture.tsx";
  const bundle = await build({ entryPoints: [fixture], bundle: true, platform: "browser", jsx: "automatic", write: false,
    alias: { "@/store/appStore": "./" + fixture, "@": "./src/renderer/src", "@shared": "./src/shared" } });
  writeFileSync(join(root, "fixture.js"), bundle.outputFiles[0].contents);
  writeFileSync(join(root, "index.html"), '<!doctype html><meta charset="utf-8"><button onclick="window.outside++">个人助理</button><div id="root"></div><script>window.outside=0</script><script src="fixture.js"></script>');
  const win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  setUiAutomationMainWindow(win);
  await win.loadFile(join(root, "index.html"), { hash: "ui-exec" });
  win.showInactive();
  const store = new BuiltinCapabilityStore(join(root, "capabilities.json"));
  const config = store.read();
  config.web.enabled = false;
  store.write(config);
  const runtime = new BuiltinCapabilityRuntime({ store,
    credentials: { has: () => false, get: () => null, set: () => {}, clear: () => {} } });
  const registered: ToolDefinition[] = [];
  createBuiltinCapabilityExtension({ taskId: "fixture", taskRoot: root, nativeExecution: true, runtime,
    browser: new BrowserAutomationService(() => null), artifactService: () => null, getProducerMessageId: () => undefined, getIsolationLevel: () => "none",
  })({ registerTool: (tool: ToolDefinition) => registered.push(tool), on: () => {} } as unknown as ExtensionAPI);
  const tool = registered.find(t => t.name === "ui_exec");
  assert(tool);
  let calls = 0;
  async function invoke(params: Record<string, unknown>, ...errorCodes: string[]) {
    assert(Value.Check(tool!.parameters, params), "model schema rejected " + JSON.stringify(params));
    const result = await tool!.execute(String(++calls), params, undefined, undefined, {} as never);
    const block = result.content[0];
    assert(block.type === "text");
    const data = JSON.parse(block.text.slice(block.text.indexOf("\n\n") + 2));
    if (errorCodes.length) { assert(result.isError, block.text); assert(errorCodes.includes(data.code), block.text); }
    else assert(!result.isError, block.text);
    return data;
  }
  const dialog = '[role="dialog"]';
  const trigger = { role: "button", name: "选择目标工作空间", within: dialog, exact: true };
  const option = { role: "button", name: "个人助理", within: dialog, exact: true };
  await invoke({ action: "wait_for", ...trigger });
  const dialogSnapshot = await invoke({ action: "snapshot", within: dialog });
  assert(dialogSnapshot.text.includes("保存副本"));
  assert(!dialogSnapshot.text.includes("个人助理"), "scoped snapshot must exclude the unrelated page button");
  await invoke({ action: "click", ...trigger });
  const found = await invoke({ action: "find", ...option });
  assert.equal(found.elements.length, 1);
  // React unmounts the option when the popup closes, then renders a new node.
  await invoke({ action: "click", ...trigger });
  await invoke({ action: "click", ...trigger });
  const stale = await invoke({ action: "click", selector: found.elements[0].selector }, "ELEMENT_NOT_FOUND");
  assert.deepEqual(stale.outcome, { dispatch: "not_started", effect: "none" });
  assert.equal(stale.scopePresent, true);
  assert.equal(stale.candidates.length, 1);
  assert.notEqual(stale.candidates[0].selector, found.elements[0].selector);
  assert.equal(await win.webContents.executeJavaScript("fixtureCopy.requests.length"), 0);
  const picked = await invoke({ action: "click", selector: stale.candidates[0].selector, after: { selector: ".workspace-popup", state: "detached" } });
  assert.equal(picked.verification.state, "detached");
  await invoke({ action: "click", within: dialog, role: "button", name: "保存副本", exact: true });
  assert.deepEqual(await win.webContents.executeJavaScript("fixtureCopy.requests"),
    [{ route: "copy", request: { gadgetId: "source", scope: { type: "workspace", workspaceId: "personal" } } }]);
  // Replacing the entire dialog invalidates its scope, including same-named replacements.
  await win.webContents.executeJavaScript("fixtureCopy.mount()");
  const gone = await invoke({ action: "click", selector: found.elements[0].selector }, "ELEMENT_NOT_FOUND");
  assert.equal(gone.scopePresent, false);
  assert.deepEqual(gone.candidates, []);
  assert.equal(await win.webContents.executeJavaScript("window.outside"), 0);
  await win.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent('<label><input type="checkbox">提醒</label><select data-testid="period"><option value="d">日</option><option value="w">周</option></select><button id="start">起点</button><button id="end">终点</button><output></output><script>document.querySelector("#end").onmouseup=e=>document.querySelector("output").value=e.isTrusted?"dropped":"";document.querySelector("#start").onmousemove=()=>document.body.dataset.hover="yes"</script>'));
  await invoke({ action: "check", label: "提醒", exact: true, checked: true });
  const unchanged = await invoke({ action: "check", label: "提醒", exact: true, checked: true });
  assert.deepEqual(unchanged.outcome, { dispatch: "not_started", effect: "none" });
  await invoke({ action: "select", testId: "period", values: ["w"] });
  await invoke({ action: "hover", selector: "#start" });
  const destination = await invoke({ action: "find", selector: "#end" });
  await invoke({ action: "drag", selector: "#start", dragTo: destination.elements[0].selector });
  assert.deepEqual(await win.webContents.executeJavaScript('[document.querySelector("input").checked,document.querySelector("select").value,document.body.dataset.hover,document.querySelector("output").value]'), [true,"w","yes","dropped"]);
  assert(isSideEffectTool("ui_exec", { action: "drag" }) && isDangerousTool("ui_exec", { action: "drag" }));
  await win.webContents.executeJavaScript(`for(let i=0;i<24;i++){const b=document.createElement("button");b.className="late";b.hidden=i<23;document.body.append(b)}
    window.submits=0;window.taps=0;document.querySelector("#start").onclick=()=>window.taps++;
    document.querySelector("#end").onmousedown=e=>{if(e.isTrusted)window.submits++;e.currentTarget.remove()};true`);
  const limited = await invoke({ action: "find", selector: ".late" });
  assert.equal(limited.elements.length, 20);
  assert.equal(limited.elementsTotal, 24);
  assert.equal(limited.elementsTruncated, true);
  const visible = await invoke({ action: "wait_for", selector: ".late", state: "visible" });
  assert.equal(visible.elements.length, 1, "a visible control beyond the first page must satisfy the wait");
  const invalid = await invoke({ action: "click", selector: "#start", after: { selector: "[" } }, "INVALID_SELECTOR");
  assert.equal(invalid.outcome.dispatch, "not_started");
  const unverified = await invoke({ action: "click", selector: "#start", after: { selector: "#never" }, timeout_ms: 750 }, "WAIT_TIMEOUT");
  assert.equal(unverified.stage, "verify");
  assert.deepEqual(unverified.outcome, { dispatch: "dispatched", effect: "confirmed" });
  assert.equal(await win.webContents.executeJavaScript("window.taps"), 1);
  const uncertain = await invoke({ action: "click", selector: "#end", timeout_ms: 1000 }, "WAIT_TIMEOUT", "EXECUTION_FAILED");
  assert.deepEqual(uncertain.outcome, { dispatch: "dispatched", effect: "unknown" });
  assert.equal(await win.webContents.executeJavaScript("window.submits"), 1);
  await win.webContents.executeJavaScript(`const scrollArea=document.createElement('div');scrollArea.id='wheel-area';scrollArea.style='width:180px;height:120px;overflow:auto';scrollArea.innerHTML='<div style="height:600px"></div>';document.body.append(scrollArea);
    const field=document.createElement('input');field.id='on-focus';field.onfocus=()=>{document.body.dataset.focused='yes';field.remove()};document.body.append(field);true`);
  const scrolled = await invoke({ action: "scroll", selector: "#wheel-area", delta_y: -60 });
  assert.deepEqual(scrolled.outcome, { dispatch: "dispatched", effect: "confirmed" });
  assert(await win.webContents.executeJavaScript("document.querySelector('#wheel-area').scrollTop>0"));
  win.focus();
  win.webContents.focus();
  assert(await win.webContents.executeJavaScript("document.hasFocus()"));
  const focusLost = await invoke({ action: "press", selector: "#on-focus", key: "Enter" }, "ELEMENT_NOT_EDITABLE");
  assert.deepEqual(focusLost.outcome, { dispatch: "dispatched", effect: "unknown" });
  assert.equal(await win.webContents.executeJavaScript("document.body.dataset.focused"), "yes");
  console.log("PASS registered ui_exec -> real workspace picker -> scoped recovery -> one correct copy; closed scope, gestures, truncated discovery and uncertain delivery without replay");
  clearTimeout(guard);
  win.destroy();
  app.exit(0);
}
void run().catch(error => { console.error(error); clearTimeout(guard); app.exit(1); });
