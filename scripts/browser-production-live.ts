/** NETWORK + real Electron. Full AgentService/Durable composition, synthetic pages/profile. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { app, BrowserWindow } from "electron";

const out = resolve(process.env.BROWSER_BENCH_OUT!);
assert(out.includes(join("out", "diagnostics", "browser-46-50")));
const home = mkdtempSync(join(tmpdir(), "browser-ab-")), config = join(home, ".mybuddy"), workspace = join(home, "workspace");
mkdirSync(config, { recursive: true });
mkdirSync(workspace);
process.env.HOME = home; process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = config;
app.setPath("home", home); app.setPath("userData", join(home, "chromium"));
app.on("window-all-closed", () => {});
const requireRoot = createRequire(resolve("package.json"));
const modelId = process.env.BROWSER_BENCH_MODEL ?? "auto/deepseek-v4.1-flash-1017";
const reasoningPreference = process.env.BROWSER_BENCH_REASONING ? { enabled: true, effort: process.env.BROWSER_BENCH_REASONING } : undefined;
const base = process.env.BROWSER_BENCH_BASE_URL ?? "http://127.0.0.1:3425/v1";
const report: any = { variant: process.env.BROWSER_BENCH_VARIANT, modelId, cases: [], calls: [], runtimeCalls: [], browserCalls: [],
  level: "real model + real Electron + production AgentService/Durable; synthetic pages and isolated profile",
  clock: "before AgentService admission until persisted host result read; excludes UI rendering/startup",
  pricing: "unknown unless provider reports cost; catalog placeholder zero is not billing evidence",
  cacheState: "provider-observed; a new local profile does not guarantee a cold provider cache",
  environment: { electron: process.versions.electron, node: process.versions.node, platform: process.platform } };
const save = () => writeFileSync(join(out, "results.json"), JSON.stringify(report, null, 2));
let current: any, agent: any, db: any, host: any, win: BrowserWindow | undefined, cron: any, terminal: any;
const guard = setTimeout(() => { report.timeout = true; save(); app.exit(1); }, 25 * 60_000);
const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks); const ordinal = report.calls.length + 1;
  const input = JSON.parse(body.toString());
  const record: any = { ordinal, case: current?.id, path: req.url, startedAt: Date.now(), inputBytes: body.length,
    requestedModel: input.model, maxTokens: input.max_tokens ?? input.max_completion_tokens, reasoning: input.reasoning_effort ?? input.reasoning,
    toolNames: input.tools?.map((tool: any) => tool.function?.name ?? tool.name), toolDefinitionChars: JSON.stringify(input.tools ?? []).length };
  report.calls.push(record); writeFileSync(join(out, `request-${ordinal}.json`), body); save();
  try {
    const response = await fetch(base.replace(/\/v1\/?$/, "") + req.url, { method: req.method, headers: { "content-type": "application/json", authorization: "Bearer isolated-local-browser-benchmark" }, body, signal: AbortSignal.timeout(180000) });
    record.httpStatus = response.status; res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/event-stream" });
    const bytes: Buffer[] = [];
    if (response.body) for await (const chunk of response.body) { bytes.push(Buffer.from(chunk)); res.write(chunk); }
    const raw = Buffer.concat(bytes).toString(); writeFileSync(join(out, `response-${ordinal}.txt`), raw);
    const frames = raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line.replace(/^data:\s*/, ""))]; } catch { return []; } });
    record.usage = frames.flatMap(frame => frame.usage ? [frame.usage] : []).at(-1) ?? null;
    record.returnedModels = [...new Set(frames.flatMap(frame => frame.model ? [frame.model] : []))];
    record.elapsedMs = Date.now() - record.startedAt; res.end(); save();
  } catch (error) { record.error = String(error); record.elapsedMs = Date.now() - record.startedAt; save(); res.destroy(error instanceof Error ? error : undefined); }
});
const marker = randomUUID(), fillValue = "林晨-" + marker.slice(0, 8);
const long = "正文片段\n".repeat(24000) + marker;
const pages = createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  const html = req.url === "/short" ? `<h1>短文</h1><p>唯一标记 ${marker}</p>`
    : req.url === "/long" ? `<article style="white-space:pre-wrap">${long}</article>`
    : req.url === "/table" ? `<table><tr><th>项目</th><th>金额</th></tr><tr><td>甲</td><td>17</td></tr><tr><td>乙</td><td>29</td></tr></table><p>核验标记 ${marker}</p>`
    : req.url === "/async" ? `<p>Loading...</p><script>setTimeout(()=>document.body.innerHTML='<main>完成标记 ${marker}</main>',400)</script>`
    : req.url === "/popup" ? "<a id='open' target='_blank' href='/short'>打开目标页</a>"
    : `<p id="clock"></p><label>姓名<input id="name"></label><label>城市<input id="city"></label><button id="submit" onclick="document.body.dataset.submissionCount=String(Number(document.body.dataset.submissionCount||0)+1);document.body.dataset.submitted=document.querySelector('#name').value+'|'+document.querySelector('#city').value;document.querySelector('#result').textContent=document.body.dataset.submitted">提交</button><p id="result">未提交</p><script>setInterval(()=>document.querySelector('#clock').textContent=Date.now(),50)</script>`;
  res.end(`<meta charset="utf-8"><title>Benchmark</title>${html}`);
});
const wait = async (predicate: () => Promise<any> | any, label: string, ms = 180000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error("Timeout: " + label);
};
void (async () => {
  await app.whenReady();
  const model = await requireRoot(resolve("scripts/bot-live-model-config.cjs")).loadLiveModel(base, modelId);
  report.model = model.evidence;
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  await new Promise<void>(done => pages.listen(0, "127.0.0.1", done));
  const address = proxy.address(), pageAddress = pages.address(); assert(address && typeof address !== "string" && pageAddress && typeof pageAddress !== "string");
  const origin = `http://127.0.0.1:${pageAddress.port}`;
  writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { acceptance: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "isolated-local-browser-benchmark", models: [model.model] } } }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultProvider: "acceptance", defaultModel: modelId, defaultModelId: `acceptance/${modelId}`, enabledModels: [`acceptance/${modelId}`], defaultThinkingLevel: process.env.BROWSER_BENCH_REASONING ?? "low", permissionMode: "auto", memoryEnabled: false, memorySemanticEnabled: false, retry: { enabled: false } }));
  writeFileSync(join(config, "auth.json"), "{}"); mkdirSync(join(config, "plugins/mcp"), { recursive: true }); writeFileSync(join(config, "plugins/mcp/mcp.json"), '{"mcpServers":{}}');
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { AgentService } = await import("../src/main/agent/AgentService");
  const { AppDatabase } = await import("../src/main/db/AppDatabase");
  const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
  const { browserHost } = await import("../src/main/browser/BrowserHost"); host = browserHost;
  const { BrowserAutomationService } = await import("../src/main/capabilities/BrowserAutomationService");
  const executeBrowser = BrowserAutomationService.prototype.execute;
  BrowserAutomationService.prototype.execute = async function(input, signal, context) {
    const call: any = { case: current?.id, input, context, startedAt: Date.now() }; report.browserCalls.push(call);
    try { const result = await executeBrowser.call(this, input, signal, context); call.result = result; return result; }
    catch (error) { call.error = String(error); call.details = error instanceof Error && "details" in error ? error.details : undefined; throw error; }
    finally { call.elapsedMs = Date.now() - call.startedAt; }
  };
  const { CronService } = await import("../src/main/cron/CronService");
  const { TerminalHost } = await import("../src/main/terminal/TerminalHost");
  const { TaskTerminalService } = await import("../src/main/terminal/TaskTerminalService");
  const { createArtifactDomain } = await import("../src/main/artifact/ArtifactDomainSetup");
  app.on("web-contents-created", (_event, wc) => {
    const command = wc.debugger.sendCommand.bind(wc.debugger);
    wc.debugger.sendCommand = async (...args) => {
      const [method] = args;
      const record: any = { case: current?.id, webContentsId: wc.id, method: `debugger.${method}`, at: Date.now() }; report.runtimeCalls.push(record);
      try { return await command(...args); }
      catch (error) { record.error = String(error); throw error; }
      finally { record.elapsedMs = Date.now() - record.at; }
    };
    for (const method of ["executeJavaScript", "sendInputEvent", "insertText", "loadURL"] as const) {
      const original = wc[method].bind(wc);
      (wc as any)[method] = (...args: any[]) => {
        const record: any = { case: current?.id, webContentsId: wc.id, method, at: Date.now() };
        report.runtimeCalls.push(record);
        try {
          const value = (original as any)(...args);
          if (value?.then) return value.then((result: any) => { record.elapsedMs = Date.now() - record.at; return result; }, (error: any) => { record.error = String(error); record.elapsedMs = Date.now() - record.at; throw error; });
          record.elapsedMs = Date.now() - record.at; return value;
        } catch (error) { record.error = String(error); throw error; }
      };
    }
  });
  win = new BrowserWindow({ show: false, width: 1000, height: 800 }); await win.loadURL("data:text/html,Production browser benchmark"); host.attach(win);
  db = new AppDatabase(join(config, "app.db"));
  const runtime = await ModelRuntime.create({ authPath: join(config, "auth.json"), modelsPath: join(config, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  agent = new AgentService(db, new TaskExecutionWorkspace(join(home, "tasks")), { models: runtime });
  terminal = new TerminalHost({ resolveCwd: () => workspace }); cron = new CronService(db, agent); agent.setLocalWorkflowServices({ cron, terminal: new TaskTerminalService(terminal) });
  const artifacts = createArtifactDomain(db.connection); agent.setArtifactDomain(artifacts.service, artifacts.coordinator);
  await agent.init(); await agent.resumePersistedTasks();
  const cases = [
    { id: "short", text: `打开 ${origin}/short，读页面并回答唯一标记。`, expected: marker },
    { id: "long", text: `打开 ${origin}/long，读到文章末尾并回答最后的唯一标记，内容超过100k字符，不要把前缀当全文。`, expected: marker },
    { id: "table", text: `打开 ${origin}/table，计算金额合计并回答核验标记。`, expected: marker, number: "46" },
    { id: "async", text: `打开 ${origin}/async，等待main区域的数据出现后回答完成标记，不把Loading当结果。`, expected: marker },
    { id: "form", text: `打开 ${origin}/form，姓名填 ${fillValue}，城市填杭州，提交一次，读取确认结果。`, expected: fillValue },
    { id: "popup", text: `打开 ${origin}/popup，通过点击“打开目标页”链接打开新标签，读取新标签并回答唯一标记，不要绕过点击。`, expected: marker },
    { id: "non-browser", text: "计算31+16，只回复数字，不使用工具。", expected: "47" },
    { id: "bot-work", text: `创建一个由你负责的一次性后台事项：在内置浏览器打开 ${origin}/short，实际读到唯一标记并在结果中返回这个标记，确认后完成事项。`, expected: marker },
    { id: "partial", text: `打开 ${origin}/form 并先观察控件。然后用同一次codemode顺序完成这四个已知步骤：1姓名填${fillValue}；2城市填杭州；3尝试点击不存在的#missing-step；4点击#submit。每步检查isError或异常，第三步失败必须立即停止，不能执行第四步。输出已完成步骤、失败位置，禁止重试。`, expected: fillValue },
  ];
  const selectedCases = process.env.BROWSER_BENCH_CASES?.split(",");
  for (const test of cases.filter(test => !selectedCases || selectedCases.includes(test.id))) {
    const taskId = "browser-bench-" + randomUUID();
    db.upsertTask({ id: taskId, title: test.id, updatedAt: Date.now(), welcomeMode: "working", modelId: `acceptance/${modelId}`, modePresetId: "codemode" });
    current = { id: test.id, taskId, prompt: test.text, startedAt: Date.now(), modelStart: report.calls.length, runtimeStart: report.runtimeCalls.length, browserStart: report.browserCalls.length };
    report.cases.push(current); save();
    try {
      if (test.id === "bot-work") {
        const created = agent.createBot({ requestId: randomUUID(), displayName: "浏览器验收", responsibilitySummary: "执行本地浏览器验证，依据实际页面返回结果" }); assert(created.ok);
        const view = await agent.getBotSettings(created.bot.botId); const { revision, spaceId, effectiveWorkspacePath, ...settings } = view.settings;
        const saved = await agent.saveBotSettings({ ...settings, modelId: `acceptance/${modelId}`, workspacePath: workspace, expectedRevision: revision });
        current.settingsSave = saved;
        assert(saved.ok, JSON.stringify(saved));
        const receipt = await agent.sendBotMessage({ botId: created.bot.botId, requestId: randomUUID(), text: test.text,
          selection: { modelId: `acceptance/${modelId}`, expertId: settings.expertId, skillIds: settings.skillIds, mcpIds: settings.mcpIds,
            connectorIds: settings.connectorIds, ...(reasoningPreference ? { reasoningPreference } : {}) } }); current.receipt = receipt;
        const work = await wait(() => db.connection.prepare("SELECT work_id FROM works WHERE owner_bot_id=?").get(created.bot.botId), "real Bot creates Work");
        current.work = await wait(() => { const value = agent.getWorkService().getWork(work.work_id); return value?.lifecycle === "closed" && value; }, "Work closes");
        current.history = await agent.botMessageHistory({ botId: created.bot.botId });
        current.resultCards = db.connection.prepare("SELECT * FROM work_result_cards WHERE work_id=?").all(work.work_id);
        assert.equal(current.work.closureConclusion, "succeeded");
        assert(JSON.stringify([current.history, current.work, current.resultCards]).includes(test.expected));
      } else {
      const prompt = test.id === "non-browser" ? test.text : `${test.text}\n浏览器交互仅用browser_exec，不用HTTP客户端、终端或源码读取绕过页面。已确定的连续动作可在codemode里顺序执行，逐步保留结果；遇错误立即停止并报告完成位置，不重复提交。不猜未知页面目标。`;
      const result = await agent.prompt({ taskId, text: prompt, assistantMessageId: randomUUID(), userMessageId: randomUUID(), permissionMode: "auto", modelId: `acceptance/${modelId}`, ...(reasoningPreference ? { reasoningPreference, reasoningPreferenceModelId: `acceptance/${modelId}` } : {}), welcomeMode: "working", modePresetId: "codemode" });
      if (result.error) throw Error(JSON.stringify(result.error));
      if (result.receipt) await wait(() => agent.submissionStatus(result.receipt).then((status: any) => !status.queued && status), "Durable task completion");
      const history = await agent.loadTaskHistory(taskId); current.history = history;
      const final = history.messages.filter((message: any) => message.role === "assistant").at(-1); current.final = final?.text ?? "";
      if (test.id !== "partial") assert(current.final.includes(test.expected), `answer missing expected fixture value: ${current.final}`);
      if (test.number) assert(current.final.includes(test.number));
      if (test.id === "form") {
        const tab = host.listTabs().find((tab: any) => tab.taskId === taskId); assert(tab);
        current.submission = await host.getTabHost(tab.id).inspectionWebContents.executeJavaScript("document.body.dataset.submitted");
        assert.equal(current.submission, fillValue + "|杭州");
        current.submissionCount = await host.getTabHost(tab.id).inspectionWebContents.executeJavaScript("Number(document.body.dataset.submissionCount)");
        assert.equal(current.submissionCount, 1, "form must be submitted exactly once");
      }
      if (test.id === "partial") {
        const tab = host.listTabs().find((tab: any) => tab.taskId === taskId); assert(tab);
        current.partial = await host.getTabHost(tab.id).inspectionWebContents.executeJavaScript("({name:document.querySelector('#name').value,city:document.querySelector('#city').value,submitted:document.body.dataset.submitted})");
        assert.equal(current.partial.name, fillValue); assert.equal(current.partial.city, "杭州"); assert.equal(current.partial.submitted, undefined);
        const codeCalls = history.messages.flatMap((message: any) => message.tools ?? []).filter((tool: any) => tool.tool === "codemode").flatMap((tool: any) => { try { return [JSON.parse(tool.detail).calls]; } catch { return []; } });
        assert(codeCalls.some((calls: any[]) => calls.length === 3 && calls[0].status === "ok" && calls[1].status === "ok" && calls[2].status === "error"), "must retain two completed nested calls and stop at third failure");
      }
      }
      current.status = "passed";
    } catch (error) { current.status = "failed"; current.error = String(error); }
    current.wallMs = Date.now() - current.startedAt; current.modelRequests = report.calls.length - current.modelStart; current.runtimeCalls = report.runtimeCalls.length - current.runtimeStart;
    current.browserCalls = report.browserCalls.length - current.browserStart;
    const calls = report.calls.slice(current.modelStart); current.usage = calls.map((call: any) => call.usage);
    current.toolResultChars = report.calls.slice(current.modelStart).reduce((sum: number, call: any) => { const request = JSON.parse(readFileSync(join(out, `request-${call.ordinal}.json`), "utf8")); return sum + (request.messages ?? []).filter((message: any) => message.role === "tool").reduce((n: number, message: any) => n + JSON.stringify(message.content).length, 0); }, 0);
    save(); console.log(test.id, current.status, current.wallMs, current.error ?? ""); await agent.releaseDurableTask(taskId); current = undefined;
  }
  report.status = report.cases.every((test: any) => test.status === "passed") ? "passed" : "failed";
})().catch(error => { report.status = "failed"; report.error = String(error?.stack ?? error); console.error(error); }).finally(async () => {
  save(); cron?.stop(); await agent?.closeDurableBots(); agent?.dispose(); terminal?.dispose(); db?.close(); host?.dispose(); if (win && !win.isDestroyed()) win.destroy();
  proxy.closeAllConnections(); proxy.close(); pages.closeAllConnections(); pages.close(); clearTimeout(guard); console.log("EVIDENCE", out); app.exit(report.status === "passed" ? 0 : 1);
});
