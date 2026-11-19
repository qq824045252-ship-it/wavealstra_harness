import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { Value } from "typebox/value";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { computerAutomationService } from "../src/main/capabilities/ComputerAutomationService";
import { computerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";

const root = mkdtempSync(join(tmpdir(), "mybuddy-control-lookup-"));
// The production main process loads Electron's native modules through require.
globalThis.require = createRequire(import.meta.url);
process.env.HOME = root;
process.env.USERPROFILE = root;
app.setPath("home", root);
app.setPath("userData", join(root, "profile"));
app.on("window-all-closed", () => { /* Read back the lookup result after the fixture closes. */ });

async function run(): Promise<void> {
  assert.equal(process.platform, "win32", "requires Windows UI Automation");
  await app.whenReady();
  app.setAccessibilitySupportEnabled(true);
  const win = new BrowserWindow({ width: 460, height: 240, show: false, focusable: false, skipTaskbar: true });
  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<title>MyBuddy lookup fixture</title><button onclick="window.clicks++">Send</button><p id="result">Working</p><script>window.clicks=0</script>'));
    win.showInactive();
    const windowHandle = win.getNativeWindowHandle().readBigUInt64LE().toString();
    const store = new BuiltinCapabilityStore(join(root, "capabilities.json"));
    const config = store.read();
    config.web.enabled = false;
    store.write(config);
    const runtime = new BuiltinCapabilityRuntime({ store, credentials: { has: () => false, get: () => null, set: () => {}, clear: () => {} } });
    const registered: ToolDefinition[] = [];
    createBuiltinCapabilityExtension({ taskId: "lookup", taskRoot: root, nativeExecution: true, runtime,
      browser: new BrowserAutomationService(() => null), artifactService: () => null, getProducerMessageId: () => undefined, getIsolationLevel: () => "none",
    })({ registerTool: (t: ToolDefinition) => registered.push(t), on: () => {} } as unknown as ExtensionAPI);
    const tool = registered.find(t => t.name === "computer_exec");
    assert(tool);
    let calls = 0;
    async function call(params: Record<string, unknown>, errorCode?: string) {
      const args = { window_handle: windowHandle, ...params };
      assert(Value.Check(tool!.parameters, args));
      const result = await tool!.execute(String(++calls), args, undefined, undefined, {} as never);
      const content = result.content[0];
      assert(content.type === "text");
      assert.equal(Boolean(result.isError), Boolean(errorCode), content.text);
      if (errorCode) { assert(content.text.includes(errorCode), content.text); return; }
      return JSON.parse(content.text.slice(content.text.indexOf("\n\n") + 2));
    }
    const marker = { action: "find_control", control_name: "RELEASE_FIXTURE_OK", control_type: "Text", exact_name: true };
    const send = await call({ action: "find_control", control_name: "Send", control_type: "Button" });
    assert(send.matched && send.control.name === "Send");
    const missing = await call({ ...marker, timeout_ms: 450 });
    assert.equal(missing.matched, false);
    assert.equal(missing.control, undefined);
    assert.equal(missing.truncated, false);
    assert(missing.observedControlCount > 0 && missing.attempts >= 2 && missing.waitedMs >= 450);
    await call({ ...marker, action: "invoke_control" }, "CONTROL_NOT_FOUND");
    await call({ ...marker, max_depth: 1 }, "CONTROL_AMBIGUOUS");
    await win.webContents.executeJavaScript('setTimeout(()=>{document.getElementById("result").textContent="RELEASE_FIXTURE_OK"},700);true');
    const delayed = await call({ ...marker, timeout_ms: 3000 });
    assert.equal(delayed.matched, true);
    assert.equal(delayed.control.name, marker.control_name);
    assert(delayed.attempts >= 2);
    assert.equal(await win.webContents.executeJavaScript("window.clicks"), 0);
    const pending = call({ ...marker, control_name: "Missing", timeout_ms: 3000 }, "WINDOW_NOT_FOUND");
    const close = setTimeout(() => win.destroy(), 400);
    try { await pending; } finally { clearTimeout(close); }
    console.log("PASS registered computer_exec -> Windows UIA: matched=false, delayed text, strict action preview, truncated tree, closed window, zero submitted clicks");
  } finally {
    computerUseRunCoordinator.endTask("lookup");
    await computerAutomationService.shutdown();
    if (!win.isDestroyed()) win.destroy();
  }
}
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
