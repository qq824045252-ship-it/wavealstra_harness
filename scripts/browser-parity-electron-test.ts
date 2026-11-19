import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService, type BrowserExecInput } from "../src/main/capabilities/BrowserAutomationService";
import { fixtureFileText, startParitySite } from "./browser-parity-site.mjs";

const root = mkdtempSync(join(tmpdir(), "mybuddy-browser-parity-"));
app.setPath("home", root);
app.setPath("userData", join(root, "profile"));
app.on("window-all-closed", () => {});
const results: Array<{ name: string; pass: boolean; error?: string }> = [];
async function test(name: string, run: () => Promise<void>) {
  try { await run(); results.push({ name, pass: true }); console.log("PASS", name); }
  catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({ name, pass: false, error }); console.error("FAIL", name, error);
  }
}

void (async () => {
  await app.whenReady();
  const site = process.env.MYBUDDY_BROWSER_PARITY_URL ? undefined : await startParitySite();
  const base = site?.url ?? process.env.MYBUDDY_BROWSER_PARITY_URL!;
  const win = new BrowserWindow({ show: false, width: 980, height: 780 });
  const host = new BrowserHost();
  const guard = setTimeout(() => { console.error("browser parity timeout"); app.exit(1); }, 180_000);
  try {
    await win.loadURL("data:text/html,Parity fixture");
    host.attach(win); host.setBounds({ x: 0, y: 0, width: 900, height: 690 }); host.show();
    const browser = new BrowserAutomationService(() => host);
    const task = { taskId: "parity", taskRoot: root };
    const execute = (input: BrowserExecInput) => browser.execute(input, undefined, task);
    const tab = await execute({ action: "navigate", url: base + "/entry" });
    assert(tab.tabId);
    const run = (input: BrowserExecInput) => execute({ tabId: tab.tabId, timeoutMs: 7000, ...input });
    const act = async (css: string, input: BrowserExecInput) => {
      const found = await run({ action: "find", selector: css, frameId: input.frameId });
      assert.equal(found.elements?.length, 1, css);
      return run({ ...input, selector: found.elements![0].selector });
    };
    const verify = async (selector: string, value: string, frameId?: string) => {
      const result = await run({ action: "assert", frameId, expect: [{ kind: "text", selector, value }] });
      assert.equal(result.businessResult?.status, "passed", JSON.stringify(result.businessResult));
    };
    await test("login", async () => {
      const result = await run({ action: "login", url: base + "/work", expect: [{ kind: "text", selector: "#account", value: "Order workspace" }] });
      assert.equal(result.login?.status, "confirmed");
      assert.equal(result.outcome?.dispatch, "dispatched");
    });
    await test("read", async () => assert.match((await run({ action: "read", mode: "text" })).text!, /Order workspace/));
    await test("fill_press", async () => {
      await act("#memo", { action: "fill", text: "你好123" });
      await act("#memo", { action: "press", key: "Enter" }); await verify("#result", "你好123");
    });
    await test("double_click", async () => { await act("#double", { action: "click", clickCount: 2 }); await verify("#double", "Double clicked"); });
    await test("select_check", async () => {
      await act("#city", { action: "select", values: ["Paris"] }); await act("#flag", { action: "check", checked: true });
      const r = await run({ action: "assert", expect: [{ kind: "value", selector: "#city", value: "Paris" }, { kind: "state", selector: "#flag", state: "checked" }] });
      assert.equal(r.businessResult?.status, "passed");
    });
    await test("hover", async () => {
      await act("#hover", { action: "hover" });
      assert.equal((await run({ action: "assert", expect: [{ kind: "count", selector: "#hover[data-hovered=yes]", count: 1 }] })).businessResult?.status, "passed");
    });
    await test("page_script", async () => {
      const result = await run({ action: "evaluate", expression: "Array.from(document.querySelectorAll('.amount'), e => Number(e.textContent)).reduce((a,b)=>a+b,0)" });
      assert.equal(result.value, 30);
    });
    await test("script_form_edit", async () => {
      const field = (await run({ action: "find", selector: "#memo" })).elements![0];
      await run({ action: "evaluate", editSelector: field.selector, expression: "document.querySelector('#memo').value += ' 单'" });
      await act("#memo", { action: "press", key: "Enter" }); await verify("#result", "你好123 单");
    });
    await test("network", async () => {
      const response = (await run({ action: "fetch", url: "/api/orders" })).fetched;
      assert.equal(response?.status, 200); assert.deepEqual(JSON.parse(response.body), { orders: [11, 19] });
    });
    await test("network_write", async () => {
      const write = await run({ action: "fetch", url: "/api/draft", request: { method: "POST", contentType: "application/json", body: JSON.stringify({ memo: "季度草稿" }) } });
      assert.equal(write.fetched?.status, 200); assert.equal(write.outcome?.dispatch, "dispatched");
      const read = await run({ action: "fetch", url: "/api/draft" });
      assert.deepEqual(JSON.parse(read.fetched!.body), { memo: "季度草稿" });
    });
    await test("binary_fetch", async () => {
      const result = await run({ action: "fetch", url: "/bytes", download: { filename: "test.bin" } });
      assert(result.download?.state === "completed"); assert.deepEqual([...readFileSync(result.download.path)], [0, 255, 13, 10, 100]);
    });
    await test("public_cors", async () => {
      const r = (await run({ action: "fetch", url: base.replace("127.0.0.1", "localhost") + "/public" })).fetched;
      assert.equal(r?.status, 200); assert.deepEqual(JSON.parse(r.body), { currency: "CNY" });
    });
    await test("focus_insert_chord", async () => {
      await act("#cursor", { action: "focus" });
      assert.equal((await run({ action: "assert", expect: [{ kind: "count", selector: "#cursor:focus[data-focused=yes]", count: 1 }] })).businessResult?.status, "passed");
      await act("#cursor", { action: "insert_text", text: "AB" });
      await act("#cursor", { action: "press", key: "ArrowLeft" });
      await act("#cursor", { action: "insert_text", text: "中" });
      await act("#cursor", { action: "press", key: "Shift+ArrowLeft" });
      await act("#cursor", { action: "insert_text", text: "甲" });
      assert.equal((await run({ action: "assert", expect: [{ kind: "value", selector: "#cursor", value: "A甲B" }] })).businessResult?.status, "passed");
    });
    await test("rich_paste", async () => {
      await act("#editor", { action: "paste", text: "重要", html: "<b>重要</b>" });
      await verify("#editor b", "重要");
    });
    await test("pointer_drag", async () => {
      const target = (await run({ action: "find", selector: "#drop" })).elements![0];
      await act("#source", { action: "drag", dragTo: target.selector }); await verify("#drop", "Dropped");
    });
    await test("wheel", async () => {
      await act("#wheel", { action: "scroll", deltaY: 100 });
      assert.equal((await run({ action: "assert", expect: [{ kind: "count", selector: "#wheel[data-scrolled=yes]", count: 1 }] })).businessResult?.status, "passed");
    });
    await test("held_key_pointer_path", async () => {
      await act("#pad", { action: "drag", modifiers: ["shift"], points: [{x: 0.1, y: 0.2}, {x: 0.5, y: 0.8}, {x: 0.8, y: 0.4}] });
      assert.equal((await run({ action: "assert", expect: [{ kind: "count", selector: "#pad[data-stroke=done]", count: 1 }] })).businessResult?.status, "passed");
    });
    writeFileSync(join(root, "fixture.txt"), fixtureFileText);
    await test("upload", async () => { await act("#upload", { action: "upload", files: ["fixture.txt"] }); await verify("#uploaded", fixtureFileText.trim()); });
    await test("file_chooser", async () => { await act("#chooser", { action: "click", files: ["fixture.txt"] }); await verify("#uploaded", "chosen " + fixtureFileText.trim()); });
    await test("download", async () => {
      const d = (await act("a[download]", { action: "click", download: { filename: "fixture.txt" } })).download;
      assert(d?.state === "completed"); assert.equal(readFileSync(d.path, "utf8"), fixtureFileText);
    });
    await test("dialog", async () => {
      await act("#dialog", { action: "click", dialogRules: [{ type: "confirm", messageIncludes: "Proceed?", answer: { action: "accept" } }] });
      await verify("#result", "Accepted");
    });
    await test("async_wait", async () => { await act("#delayed", { action: "click" }); await verify("#result", "Ready"); });
    await test("scoped_event_script", async () => {
      const { listenerId } = await act("#delayed", { action: "listen", eventType: "click" });
      assert(listenerId);
      assert.equal((await run({ action: "evaluate", listenerId, expression: "event" })).value, null);
      await act("#delayed", { action: "click" });
      assert.equal((await run({ action: "evaluate", listenerId, expression: "event.trusted && event.type" })).value, "click");
    });
    await test("iframe", async () => {
      const frame = (await run({ action: "frames" })).frames?.find(f => f.url.endsWith("/frame")); assert(frame);
      await act("#inside", { action: "click", frameId: frame.frameId }); await verify("#inside", "Frame clicked", frame.frameId);
    });
    await test("shadow", async () => { await act("#shadow", { action: "click" }); await verify("#shadow", "Shadow clicked"); });
    await test("screenshot", async () => { const result = await run({ action: "screenshot" }); assert(result.captureId && result.screenshot && result.screenshot.length > 500); });
    await test("popup", async () => {
      const receipt = await act("a[target=_blank]", { action: "click" });
      assert(receipt.openedTabId);
      const result = await run({ action: "assert", tabId: receipt.openedTabId, expect: [{ kind: "text", selector: "h1", value: "Popup receipt" }] });
      assert.equal(result.businessResult?.status, "passed");
    });
    await test("new_tab_session", async () => {
      const next = await execute({ action: "open", url: base + "/work" }); assert(next.tabId && next.tabId !== tab.tabId);
      assert.equal((await run({ action: "assert", tabId: next.tabId, expect: [{ kind: "text", selector: "#account", value: "Order workspace" }] })).businessResult?.status, "passed");
    });
    // The full comparison includes exploratory cases even when a backend lacks them.
    if (process.env.MYBUDDY_BROWSER_PARITY_FULL === "1") await test("live_script_event", async () => {
      await run({ action: "evaluate", expression: "document.querySelector('#delayed').addEventListener('click', () => { window.browserParityClicks = 1; }, {once:true})" });
      await act("#delayed", { action: "click" });
      const result = await run({ action: "evaluate", expression: "window.browserParityClicks ?? 0" });
      assert.equal(result.value, 1, "page must retain the listener and deliver the subsequent real click");
    });
    if (process.env.MYBUDDY_BROWSER_PARITY_REPORT) writeFileSync(process.env.MYBUDDY_BROWSER_PARITY_REPORT, JSON.stringify(results, null, 2));
    assert.equal(results.filter(r => !r.pass).length, 0);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(guard); host.dispose(); win.destroy(); site?.close(); app.exit(process.exitCode === 1 ? 1 : 0); }
})().catch(error => { console.error(error); app.exit(1); });
