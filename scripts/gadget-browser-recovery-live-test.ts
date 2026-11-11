/** Live model + real Electron browser. Only public gateway metadata; no user profile/credentials. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { app, BrowserWindow } from "electron";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { createGadgetAgentExtension } from "../src/main/gadget/gadget-agent-extension";

const temporaryParent = join(process.cwd(), "out/tests/browser-live-profiles");
mkdirSync(temporaryParent, { recursive: true });
const root = mkdtempSync(join(temporaryParent, "run-"));
process.env.HOME = root; process.env.USERPROFILE = root;
app.setPath("home", root); app.setPath("userData", join(root, "profile"));
const reportPath = join(process.cwd(), "artifacts/gadget-browser-recovery-live", process.env.MYBUDDY_BROWSER_LIVE_REPORT === "final" ? "final-results.json" : "results.json");
mkdirSync(join(process.cwd(), "artifacts/gadget-browser-recovery-live"), { recursive: true });
const base = process.env.MYBUDDY_BROWSER_LIVE_URL ?? "http://127.0.0.1:3425/v1";
const require = createRequire(import.meta.url);
const { liveModelFromCatalog } = require(join(process.cwd(), "scripts/bot-live-model-config.cjs"));
const report: any = { at: new Date().toISOString(), fixture: root, cases: [], transport: "live chat/completions tool loop", execution: "production built-in extension + BrowserHost/BrowserAutomationService + GadgetService/Runtime", systemPrompt: "你是测试本地浏览器的助手。必须实际使用提供的工具完成用户任务，依据工具结果回答。浏览器操作仅使用 browser_exec，不得启动外部浏览器。read 返回页面文字；改变页面后再次 read，再继续输入或点击。工具出错时读取明确错误并恢复，不盲目重试。不要调用 screenshot，此测试核验 DOM 和导航，不需要图片。" };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
let host: BrowserHost | undefined; let win: BrowserWindow | undefined; let gadgets: GadgetRuntime | undefined; let db: AppDatabase | undefined;
const guard = setTimeout(() => { report.timeout = true; save(); app.exit(1); }, 20 * 60_000);
app.on("window-all-closed", () => {});

async function run() {
  await app.whenReady();
  const catalogResponse = await fetch(`${base}/models`, { signal: AbortSignal.timeout(15000) });
  assert(catalogResponse.ok, `catalog HTTP ${catalogResponse.status}`);
  const catalog: any = await catalogResponse.json();
  const preferred = process.env.MYBUDDY_BROWSER_LIVE_MODEL ?? "opendesign/deepseek-v4.1-flash-eco";
  const selected = catalog.data.some((m: any) => m.id === preferred) ? preferred : "opendesign/deepseek-v4.1-flash";
  const metadata = liveModelFromCatalog(catalog, selected);
  report.model = metadata.evidence; report.model.source = `${base}/models`; save();
  win = new BrowserWindow({ show: false, width: 1000, height: 800 });
  await win.loadURL("data:text/html,<body>Isolated live browser harness</body>");
  host = new BrowserHost(() => true); host.attach(win); host.setBounds({ x: 0, y: 0, width: 900, height: 680 });
  const browser = new BrowserAutomationService(() => host!);
  const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  for (const key of ["web", "vision", "imageGeneration", "videoGeneration", "speechToText", "textToSpeech", "subagent", "multiModelConsult", "diagnostics"] as const) { const capability = config[key]; if (capability) capability.enabled = false; }
  config.execution.codeExecutionEnabled = false; config.execution.terminalEnabled = false;
  db = new AppDatabase(join(root, "app.db"));
  const taskIds = ["table-arithmetic", "form-fill", "target-blank", "local-html", "gadget-update-running", "gadget-stopped-recovery"].map(id => `browser-live-${id}`);
  for (const id of taskIds) db.upsertTask({ id, title: id, updatedAt: Date.now() });
  const storage = new GadgetStorage(join(root, "gadgets")); const registry = new GadgetRegistry();
  gadgets = new GadgetRuntime(storage, registry);
  const service = new GadgetService({ repository: new GadgetRepository(db.connection), storage, registry, runtime: gadgets,
    workspaceExists: () => false, workspaceEffectiveArchived: () => false, taskExists: id => taskIds.includes(id), taskWorkspaceId: () => null, workspaceAncestors: () => [] });
  browser.setGadgetPreviewResolver((url,taskId,gadgetId) => service.resolveBrowserPreview(url,taskId,gadgetId));
  const pageFor = (record: any) => {
    const id = [...record.calls].reverse().map((call: any) => call.result?.details?.openedTabId ?? call.result?.details?.tabId).find(Boolean);
    assert(id, "No task-owned browser tab observed"); return host!.getTabHost(id)!.inspectionWebContents!;
  };
  const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Live browser fixture</title></head><body>${body}</body></html>`;
  const table = page('<h1>库存结算</h1><table><tr><th>商品</th><th>单价</th><th>数量</th></tr><tr><td>Alpha</td><td>17</td><td>3</td></tr><tr><td>Beta</td><td>23</td><td>4</td></tr></table>');
  const form = page('<h1>本地测试表单</h1><label>姓名<input id="name"></label><label>城市<input id="city"></label><button id="submit" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value+\' / \'+document.querySelector(\'#city\').value">提交</button><p id="result">尚未提交</p>');
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(req.url === "/table" ? table : req.url === "/form" ? form : req.url === "/links" ? page('<a id="destination" href="/destination" target="_blank">打开目标页</a>') : page('<h1>内置新窗口目标</h1><p>Destination marker: ORBIT-7294</p>')); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const localPath = join(root, "local preview #1.html"); writeFileSync(localPath, page('<h1>本地 HTML 预览</h1><p>Local preview marker: LOCAL-5832</p>'));
  const gadget = service.create({ name: "Live preview", scope: { type: "task", taskId: "browser-live-gadget-update-running" }, files: [{ path: "index.html", content: page('<h1>Version one</h1><p>Preserve marker: KEEP-6458</p>') }] });
  const initial = await service.start(gadget.id); assert.equal(initial.status, "running");
  const stoppedGadget = service.create({ name: "Stopped preview", scope: { type: "task", taskId: "browser-live-gadget-stopped-recovery" }, files: [{ path: "index.html", content: page('<h1>Version two</h1><p>Preserve marker: KEEP-6458</p>') }] });
  const stoppedInitial = await service.start(stoppedGadget.id); assert.equal(stoppedInitial.status, "running");
  const cases = [
    { id: "table-arithmetic", prompt: `用内置浏览器打开 ${origin}/table，读取表格，计算所有商品单价×数量的总金额，回答总金额。`, verify: (r: any) => { assert.match(r.final, /143/); assert(r.calls.some((c: any) => c.name === "browser_exec" && c.args.action === "read")); } },
    { id: "form-fill", prompt: `用内置浏览器打开 ${origin}/form，把姓名填为林晨、城市填为杭州，点击提交并读取确认结果。每次改变页面后重新 read 获取最新观察，不要直接执行 JavaScript。`, verify: async (r: any) => assert.equal(await pageFor(r).executeJavaScript("document.querySelector('#result').textContent"), "林晨 / 杭州") },
    { id: "target-blank", prompt: `用内置浏览器打开 ${origin}/links，读取页面并点击“打开目标页”链接（不要绕过点击直接导航），读取目标页并回答标记。`, verify: (r: any) => { assert.match(r.final, /ORBIT-7294/); assert(r.calls.some((c: any) => c.args.action === "click")); assert.equal(pageFor(r).getURL(), `${origin}/destination`); } },
    { id: "local-html", prompt: `使用内置浏览器直接打开本机 HTML ${pathToFileURL(localPath).href}，读取页面并回答预览标记。`, verify: (r: any) => assert.match(r.final, /LOCAL-5832/) },
    { id: "gadget-update-running", prompt: `已有 Gadget ${gadget.id} 正在运行。先读取源码，把主标题 Version one 改为 Version two，保留标记和其他内容，只修改一次。用 gadget_update 返回的当前预览 URL 在内置浏览器打开并 read 验证版本和标记。不要创建新 Gadget。`, verify: (r: any) => { assert.match(r.final, /Version two/); assert.match(r.final, /KEEP-6458/); assert.equal(r.calls.filter((c: any) => c.name === "gadget_update").length, 1); assert.equal(service.get(gadget.id)!.runtime.pid, initial.pid); } },
    { id: "gadget-stopped-recovery", prepare: async () => { await service.stop(stoppedGadget.id); }, prompt: `Gadget ${stoppedGadget.id} 的预览服务已正常停止。先用内置浏览器 navigate 打开它原来的地址 ${stoppedInitial.url}，观察工具返回的当前地址和恢复信息。然后读取该 Gadget 源码，将标题 Version two 改为 Version three，保留标记，只修改一次。用更新后的当前预览地址打开并 read，回答最终标题、标记及恢复结果。不重复源码修改，不猜端口。`, verify: (r: any) => { assert.match(r.final, /Version three/); assert.match(r.final, /KEEP-6458/); assert(r.calls.some((c: any) => c.name === "browser_exec" && c.result?.details?.recoveredFromUrl === stoppedInitial.url)); assert.equal(r.calls.filter((c: any) => c.name === "gadget_update").length, 1); assert.notEqual(service.get(stoppedGadget.id)!.runtime.pid, stoppedInitial.pid); } },
  ];
  try {
    for (const test of cases) {
      const taskId = `browser-live-${test.id}`;
      const definitions: any[] = [];
      await createBuiltinCapabilityExtension({ taskId, taskRoot: root, nativeExecution: true,
        runtime: { config: () => config } as any, browser, artifactService: () => null, getProducerMessageId: () => undefined, getIsolationLevel: () => "none",
      })({ registerTool: (tool: any) => definitions.push(tool), on: () => {} } as any);
      await createGadgetAgentExtension({ taskId, resolveWorkspaceId: () => null, service, getPermissionMode: () => "auto",
        requestApproval: async () => { throw Error("Unexpected approval in isolated task fixture"); },
      })({ registerTool: (tool: any) => definitions.push(tool) } as any);
      const allowed = definitions.filter(t => ["browser_exec", "gadget_read", "gadget_update", "gadget_open"].includes(t.name));
      const toolSchemas = allowed.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const toolByName = new Map(allowed.map(t => [t.name, t]));
      await test.prepare?.();
      const record: any = { id: test.id, taskId, prompt: test.prompt, calls: [], startedAt: new Date().toISOString() }; report.cases.push(record); save();
      const messages: any[] = [{ role: "system", content: report.systemPrompt }, { role: "user", content: test.prompt }];
      try {
        for (let round = 0; round < 18; round++) {
          const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: selected, messages, tools: toolSchemas, tool_choice: "auto", stream: false, max_tokens: metadata.model.maxTokens }), signal: AbortSignal.timeout(120_000) });
          assert(response.ok, `model HTTP ${response.status}: ${(await response.clone().text()).slice(0, 300)}`);
          const answer: any = await response.json(); record.responseModel = answer.model;
          const message = answer.choices?.[0]?.message; assert(message, "model returned no message"); messages.push(message);
          if (!message.tool_calls?.length) { record.final = message.content ?? ""; break; }
          for (const call of message.tool_calls) {
            const args = JSON.parse(call.function.arguments); const tool = toolByName.get(call.function.name); assert(tool, `unknown tool ${call.function.name}`);
            const result = await tool.execute(call.id, args, AbortSignal.timeout(30_000), () => {}, { model: metadata.model });
            const callRecord = { name: call.function.name, args, error: Boolean(result.isError), result }; record.calls.push(callRecord); save();
            console.log(test.id, call.function.name, args.action ?? "", result.isError ? "ERROR" : "OK");
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          }
        }
        assert(record.final, "No final answer within 18 rounds"); await test.verify(record); record.passed = true;
      } catch (error) { record.passed = false; record.failure = error instanceof Error ? error.message : String(error); if (error instanceof Error && error.cause) record.failureCause = String(error.cause); }
      record.finishedAt = new Date().toISOString(); save(); console.log(record.passed ? "PASS" : "FAIL", test.id, record.failure ?? record.final);
    }
  } finally { server.close(); }
  report.retainedTabs = host.listTabs().filter(tab => tab.taskId);
  assert.equal(new Set(report.retainedTabs.map((tab: any) => tab.taskId)).size, 6, "Six distinct task browser owners must coexist");
  assert.equal(report.cases.filter((item: any) => item.passed).length, 6, "Not all six live cases passed");
}
void run().then(() => { report.passed = true; }, error => { report.passed = false; report.failure = error instanceof Error ? error.stack : String(error); console.error(error); }).finally(async () => {
  await gadgets?.disposeAll(); db?.close(); host?.dispose(); if (win && !win.isDestroyed()) win.destroy(); clearTimeout(guard); save(); console.log("Evidence:", reportPath); app.exit(report.passed ? 0 : 1);
});
