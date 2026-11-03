import assert from "node:assert/strict";
import { app, BrowserWindow } from "electron";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiAutomationService as ui, setUiAutomationMainWindow, UiAutomationError } from "../src/main/capabilities/UiAutomationService";
import { computerUseRunCoordinator as coordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";
import { computerUseOverlayService as overlay } from "../src/main/platform/computer-use/overlay";
import { SessionEventCoordinator } from "../src/main/agent/SessionEventCoordinator";

const profile = mkdtempSync(join(tmpdir(), "mybuddy-cu-behavior-"));
app.setPath("userData", profile); process.env.HOME = profile; process.env.USERPROFILE = profile;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  throw new Error("condition did not become true");
}
const results: string[] = [];
const errorCode = (code: string) => (e: unknown) => e instanceof UiAutomationError && e.code === code;
async function main() {
  await app.whenReady();
  const main = new BrowserWindow({ show: false, width: 500, height: 350, webPreferences: { sandbox: true } });
  setUiAutomationMainWindow(main);
  await main.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<title>CU fixture</title><style>button,input{margin:12px;padding:12px}</style>
    <button id="a" onclick="document.querySelector('#count').textContent=++window.clicked">保存</button>
    <button id="b">保存</button><input aria-label="Note"><output id="count">0</output><script>window.clicked=0</script>`));
  main.showInactive();
  const wc = main.webContents;
  const extra = new BrowserWindow({ show: false, focusable: false });
  await extra.loadURL("data:text/html,<title>__MYBUDDY_COMPUTER_USE_CONTROLS__</title><button>Stop</button>");
  assert.equal((await ui.execute({ action: "status" })).title, "CU fixture"); results.push("new overlay cannot become app target");
  await assert.rejects(ui.execute({ action: "click", selector: "button" }), errorCode("ELEMENT_AMBIGUOUS"));
  await assert.rejects(ui.execute({ action: "click", role: "button", name: "保存" }), errorCode("ELEMENT_AMBIGUOUS"));
  results.push("duplicate controls rejected for CSS and semantic locators");
  const snap = await ui.execute({ action: "snapshot" });
  const ref = snap.elements!.find(x => x.id === "a")!.selector;
  await wc.executeJavaScript(`document.body.append(document.querySelector('#a'))`);
  await ui.execute({ action: "click", selector: ref });
  await until(async () => await wc.executeJavaScript("window.clicked") === 1);
  results.push("snapshot locator round-trip and DOM reorder preserve exact identity");
  await ui.execute({ action: "snapshot" });
  await assert.rejects(ui.execute({ action: "click", selector: ref }), errorCode("ELEMENT_NOT_FOUND"));
  const fresh = (await ui.execute({ action: "find", selector: "#a" })).elements![0].selector;
  await wc.executeJavaScript(`document.querySelector('#a').outerHTML='<button id="a">replacement</button>'`);
  await assert.rejects(ui.execute({ action: "click", selector: fresh }), errorCode("ELEMENT_NOT_FOUND"));
  results.push("new snapshot and replaced DOM node invalidate old locators");
  await wc.executeJavaScript(`document.querySelector('#a').disabled=true`);
  await assert.rejects(ui.execute({ action: "click", selector: "#a" }), errorCode("ELEMENT_DISABLED"));
  await wc.executeJavaScript(`document.querySelector('#a').disabled=false;const cover=document.createElement('div');cover.id='cover';cover.style='position:fixed;inset:0;background:white;z-index:9999';document.body.append(cover)`);
  await assert.rejects(ui.execute({ action: "click", selector: "#a" }), errorCode("ELEMENT_NOT_VISIBLE"));
  await wc.executeJavaScript(`document.querySelector('#cover').remove()`);
  results.push("disabled and occluded targets cannot report successful clicks");
  wc.focus();
  await ui.execute({ action: "fill", role: "textbox", name: "Note", value: "中文🙂 punctuation + test" });
  await until(async () => await wc.executeJavaScript("document.querySelector('input').value") === "中文🙂 punctuation + test");
  await ui.execute({ action: "press", role: "textbox", name: "Note", key: "Control+A" });
  await until(async () => await wc.executeJavaScript("document.querySelector('input').selectionStart===0 && document.querySelector('input').selectionEnd===document.querySelector('input').value.length"));
  results.push("Unicode fill and real Control+A input events");
  const abort = new AbortController();
  const waiting = ui.execute({ action: "wait_for", selector: "#never", timeoutMs: 30000 }, abort.signal);
  abort.abort(); await assert.rejects(waiting, (e: unknown) => e instanceof Error && e.name === "AbortError");
  results.push("cancelled wait exits without waiting for timeout");
  const stalePageRef = (await ui.execute({ action: "find", selector: "#a" })).elements![0].selector;
  await wc.loadURL("data:text/html,<title>Next document</title><button id=a>different target</button>");
  await assert.rejects(ui.execute({ action: "click", selector: stalePageRef }), errorCode("ELEMENT_NOT_FOUND"));
  results.push("navigation invalidates locators even when DOM IDs repeat");
  extra.destroy();

  for (const stopReason of ["stop", "aborted", "error"] as const) {
    const taskId = "terminal-" + stopReason, executionId = "execution-" + stopReason;
    const parent = new AbortController(); coordinator.scope(taskId, parent.signal, executionId);
    let deliver: (event: unknown) => void = () => {};
    const patches: string[] = [];
    const session = { messages: [{ role: "assistant", stopReason, errorMessage: "fixture", content: [] }], subscribe: (fn: typeof deliver) => { deliver = fn; return () => {}; } };
    const entry = { session, assistantMessageId: "reply-" + stopReason, executionId, pendingAssistantTurns: [], startedAt: Date.now() };
    const events = new SessionEventCoordinator({ registry: { get: () => entry }, userTurnCounters: new Map(),
      emitPatch: (p: { type: string }) => patches.push(p.type), emitContextUsage: () => {},
      endComputerUse: (id: string, execution: string, outcome: "completed" | "failed") => coordinator.endTask(id, outcome, execution),
      emitLifecycle: () => {}, finalizePendingMemoryTurn: () => {}, deletePendingMemoryTurn: () => {},
      runtimeSnapshots: { finishByAssistantMessage: () => {} }, skillEffectiveness: { markTurnOutcome: () => {} }, loadoutObservations: { markOutcome: () => {} },
    } as never);
    events.attach(taskId, "", session as never);
    coordinator.prepare({ action: "list_windows", taskId });
    coordinator.complete({ action: "list_windows", taskId }, { action: "list_windows" });
    await until(() => BrowserWindow.getAllWindows().some(w => w.getTitle().includes("COMPUTER_USE_OVERLAY") && w.isVisible()));
    deliver({ type: "agent_settled", aborted: stopReason === "aborted" });
    assert(patches.includes("assistant_end"));
    await until(() => BrowserWindow.getAllWindows().filter(w => w.getTitle().includes("COMPUTER_USE_")).every(w => !w.isVisible()));
    results.push(`${stopReason} settlement hides BOTH native windows with notification listener absent`);
  }
  const parent = new AbortController(); coordinator.scope("parent-abort", parent.signal, "old");
  coordinator.prepare({ action: "list_windows", taskId: "parent-abort" });
  await until(() => BrowserWindow.getAllWindows().some(w => w.getTitle().includes("COMPUTER_USE_OVERLAY") && w.isVisible()));
  parent.abort();
  await until(() => BrowserWindow.getAllWindows().filter(w => w.getTitle().includes("COMPUTER_USE_")).every(w => !w.isVisible()));
  results.push("parent abort alone hides overlay without waiting for provider settlement");
  main.destroy(); assert.equal(ui.available(), false); results.push("destroyed main window does not fall back to hidden overlay");
  mkdirSync("out/tests", { recursive: true });
  writeFileSync("out/tests/computer-use-behavior.json", JSON.stringify({ results }, null, 2));
  console.log(`Computer Use Electron behavior PASS (${results.length} scenarios)\n` + results.join("\n"));
}
void main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  overlay.dispose(); for (const w of BrowserWindow.getAllWindows()) w.destroy(); app.exit(Number(process.exitCode) || 0);
});
