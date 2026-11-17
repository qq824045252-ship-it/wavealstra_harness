import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { pageInspectionService } from "../src/main/artifact/PageInspectionService";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService, type BrowserExecInput, type BrowserExecOutput } from "../src/main/capabilities/BrowserAutomationService";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";

interface ToolResult { isError?: boolean; details?: unknown; }
interface RegisteredTool { name: string; execute(id: string, params: BrowserExecInput, signal: AbortSignal): Promise<ToolResult> }
const root = mkdtempSync(join(tmpdir(), "browser-handoff-tool-"));
app.setPath("home", root); app.setPath("userData", join(root, "profile"));
app.on("window-all-closed", () => {});
const guard = setTimeout(() => { console.error("handoff tool test timed out"); app.exit(1); }, 30_000);
const server = createServer((_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end("<button id='login'>Sign in</button><p id='status'>Signed out</p><script>document.querySelector('#login').onclick=e=>{document.querySelector('#status').textContent=e.isTrusted?'Signed in':'untrusted'}</script>"); });
let win: BrowserWindow | undefined;

function output(result: ToolResult): BrowserExecOutput {
  assert(result.details && typeof result.details === "object" && "action" in result.details);
  return result.details as BrowserExecOutput;
}

void (async () => {
  let db: AppDatabase | undefined;
  try {
    await app.whenReady();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    win = new BrowserWindow({ show: true, width: 900, height: 650 });
    await win.loadURL("data:text/html,isolated browser handoff tool fixture");
    const host = new BrowserHost(); host.attach(win);
    host.setBounds({ x: 80, y: 80, width: 700, height: 500 }); host.show();
    const browser = new BrowserAutomationService(() => host);
    db = new AppDatabase(":memory:");
    db.upsertTask({ id: "task-a", title: "Browser handoff", updatedAt: Date.now() });
    const interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
    const context = { taskId: "task-a", executionId: "execution-a", assistantMessageId: "message-a" };
    const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
    for (const key of ["web", "vision", "imageGeneration", "videoGeneration", "speechToText", "textToSpeech", "subagent", "multiModelConsult", "diagnostics", "ocr"] as const) {
      if (config[key]) config[key].enabled = false;
    }
    config.execution.codeExecutionEnabled = false; config.execution.terminalEnabled = false;
    const store = new BuiltinCapabilityStore(join(root, "capabilities.json")); store.write(config);
    const runtime = new BuiltinCapabilityRuntime({ store, credentials: { has: () => false, get: () => null, set: () => { throw Error("no credentials"); }, clear: () => {} } });
    const registered: RegisteredTool[] = [];
    createBuiltinCapabilityExtension({ taskId: "task-a", taskRoot: root, nativeExecution: true, runtime, browser,
      browserHandoff: (request, key, signal) => interactions.requestDurable(context, request, { key, signal }),
      artifactService: () => null, getProducerMessageId: () => "message-a", getIsolationLevel: () => "none",
    })({ registerTool: tool => { if (tool.name === "browser_exec") registered.push(tool as unknown as RegisteredTool); } } as unknown as ExtensionAPI);
    const tool = registered.find(value => value.name === "browser_exec"); assert(tool);
    const signal = new AbortController().signal;
    const opened = output(await tool.execute("open-call", { action: "navigate", url }, signal));
    assert(opened.tabId);
    let settled = false;
    const waiting = tool.execute("handoff-call", { action: "handoff", tabId: opened.tabId, reason: "login" }, signal)
      .then(result => { settled = true; return result; });
    for (let i = 0; i < 100 && !interactions.listByTask("task-a").some(item => item.status === "pending"); i++) await new Promise(resolve => setTimeout(resolve, 20));
    const question = interactions.listByTask("task-a").find(item => item.status === "pending"); assert(question);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(settled, false, "registered browser tool must wait for actual user answer");
    assert.equal(host.activeTabId, opened.tabId, "handoff presents exact retained tab");
    const guessed = await tool.execute("guessed-resume", { action: "resume", tabId: opened.tabId, token: "model-guessed", expect: [{ kind: "text", selector: "#status", value: "Signed in" }] }, signal);
    assert.equal(guessed.isError, true, "model cannot self-assert handoff completion");
    const page = host.getTabHost(opened.tabId)?.inspectionWebContents; assert(page);
    const rect = await page.executeJavaScript("(() => {const r=document.querySelector('#login').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()") as { x: number; y: number };
    const inspector = pageInspectionService.sessionFor(page, "browser-host"); assert(inspector?.isAttached);
    await inspector.protocolCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await inspector.protocolCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    assert.equal(await page.executeJavaScript("document.querySelector('#status').textContent"), "Signed in");
    assert.equal(interactions.respond(question.id, true).ok, true);
    const handed = output(await waiting); assert(handed.handoff?.token);
    const resumed = output(await tool.execute("resume-call", { action: "resume", tabId: opened.tabId, token: handed.handoff.token,
      expect: [{ kind: "text", selector: "#status", value: "Signed in" }] }, signal));
    assert.equal(resumed.handoff?.status, "confirmed");
    assert.equal(resumed.businessResult?.status, "passed");
    const replay = await tool.execute("resume-replay", { action: "resume", tabId: opened.tabId, token: handed.handoff.token,
      expect: [{ kind: "text", selector: "#status", value: "Signed in" }] }, signal);
    assert.equal(replay.isError, true, "resume token is one-shot");
    console.log("PASS registered browser_exec + real interaction service + trusted login input + verified one-shot resume");
    win.destroy(); db.close(); server.close(); clearTimeout(guard); app.exit(0);
  } catch (error) {
    console.error(error); win?.destroy(); db?.close(); server.close(); clearTimeout(guard); app.exit(1);
  }
})();
