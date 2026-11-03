/**
 * 安卓端 ACP（Agent Client Protocol）功能验收测试。
 *
 * 覆盖真实链路而不是桩：
 *  A. 真实 ExternalAgentRuntime + mock ACP Agent 进程（scripts/fixtures/mock-acp-agent.mjs）
 *  B. 真实 RemoteAccessService / RemoteTaskCommandService / RemoteAccessServer
 *  C. 真实 HTTP 客户端 RemoteClient（手机端用的同一个类）
 *  D. 手机端 store 的 sendAcp / resolveAcpPermission 提交语义
 *
 * 断言要点：
 *  1. /v1/acp/agents 只投影「已启用」的 Agent，不可用的标记 unavailable（不是凭空消失）
 *  2. 未知 / 已停用 / 未就绪的 Agent 一律 400，且不产生 run
 *  3. POST /v1/tasks/:id/acp → 202 + run 投影，runtime() 立刻看到 acpRun 与 busy
 *  4. ACP 权限请求出现在 pendingActions（approvalKind='acp'），客户端必须回传 optionId 才能放行
 *  5. 无效 optionId / 已失效审批返回 4xx；重复发起同一任务被 409 拒绝
 *  6. 完成后 history() 的消息带 acp 运行投影，文本包含 mock 的真实输出
 *  7. 同 Agent 续聊 → continuationMode=resume；跨 Agent 续聊被拒绝
 *  8. 停止（abort）会同时取消 ACP 进程（旧实现只停内置 Pi）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExternalAgentRuntime } from "../src/main/external-agent/ExternalAgentRuntime";
import { RemoteAccessPairing } from "../src/main/remote/RemoteAccessPairing";
import { RemoteAccessServer } from "../src/main/remote/RemoteAccessServer";
import { RemoteAccessService, liveAcpRunForTask, mapRemoteAcpRun } from "../src/main/remote/RemoteAccessService";
import { RemoteDeviceStore } from "../src/main/remote/RemoteDeviceStore";
import { RemoteEventBus } from "../src/main/remote/RemoteEventBus";
import { RemoteTaskCommandService } from "../src/main/remote/RemoteTaskCommandService";
import { RemoteClient } from "../app/remote/src/api/RemoteClient";
import { useRemoteStore } from "../app/remote/src/store/remoteStore";

const root = mkdtempSync(join(tmpdir(), "mybuddy-remote-acp-test-"));
const workspace = join(root, "workspace");
mkdirSync(workspace);
const fixture = join(process.cwd(), "scripts", "fixtures", "mock-acp-agent.mjs");
const TASK = "task-acp-remote";

let passed = 0;
function ok(label: string): void { passed += 1; console.log(`  ✓ ${label}`); }

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor<T>(probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value as T;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * 等上一个 ACP 轮次真的结束再发下一轮。
 *
 * history() 已经有输出 ≠ busy 已经清掉：CI runner 只有 2-4 vCPU，ACP 进程退出与
 * runtime 清理之间会有可观测的窗口，此时直接续聊会撞 409「该任务已有 ACP Agent
 * 正在执行」（未捕获的 RemoteApiError，整条用例红）。本地快机器上几乎撞不到。
 */
async function waitIdle(): Promise<void> {
  await waitFor(() => (service.runtime(TASK)?.busy ? undefined : true), "previous ACP run idle");
}

function httpJson(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function expectApiError(promise: Promise<unknown>, status: number, label: string): Promise<void> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  assert.ok(error, `${label}: 期望失败但成功了`);
  assert.equal((error as { status?: number }).status, status, `${label}: 期望 HTTP ${status}，实际 ${(error as { status?: number }).status}（${(error as Error).message}）`);
  ok(label);
}

const db = new AppDatabase(join(root, "app.db"));
const runtime = new ExternalAgentRuntime(db, () => workspace, async () => []);
let behavior = "default";

// 可写的设置桩：权限策略由手机端写入，listAgents 再从设置合并（与真实 Runtime 同语义）
const appSettings = {
  defaultModelId: null as string | null,
  permissionMode: "default",
  externalAgentPermissionPolicies: { devin: "auto-allow" } as Record<string, string>,
};

// 复用真实 Runtime 的执行链，只把「探测」与「启动」换成 mock（不依赖本机装了哪些 CLI）
(runtime as unknown as { listAgents: () => unknown }).listAgents = () => [
  { id: "devin", name: "Devin", protocol: "acp", available: true, availability: "ready", commandLabel: "mock-acp", detail: "mock", enabled: true, permissionPolicy: appSettings.externalAgentPermissionPolicies.devin ?? "ask" },
  { id: "codex", name: "Codex", protocol: "acp", available: false, availability: "missing", commandLabel: "codex-acp", detail: "未检测到 codex CLI", enabled: true, permissionPolicy: appSettings.externalAgentPermissionPolicies.codex ?? "ask" },
  { id: "claude", name: "Claude", protocol: "acp", available: true, availability: "ready", commandLabel: "claude-agent-acp", detail: "mock", enabled: false, permissionPolicy: appSettings.externalAgentPermissionPolicies.claude ?? "ask" },
];
(runtime as unknown as { launch: (m: unknown, cwd: string) => unknown }).launch = (_manifest: unknown, runCwd: string) => spawn(process.execPath, [fixture], {
  cwd: runCwd,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, MOCK_ACP_BEHAVIOR: behavior },
});
const uiEvents: Array<{ taskId: string; type: string; status?: string }> = [];
runtime.setSend((event) => { uiEvents.push({ taskId: event.taskId, type: event.patch.type, status: (event.patch as { status?: string }).status }); });

const agentStub = {
  loadTaskHistory: async () => ({ messages: [] }),
  isTaskBusy: () => false,
  listPendingActions: () => [],
  getConversationRuntimeSnapshot: () => ({ taskId: TASK, interactions: [], activeGoal: null }),
  listModels: async () => [],
  getModeProfile: (id: string) => ({ labelZh: id, policy: { presets: [] } }),
  // 续聊判定要求「工作目录仍是本任务权威 root」：测试里任务 cwd 就是 workspace
  resolveTaskExecutionWorkspaceCwd: () => workspace,
  abort: async () => undefined,
} as never;
const notifications = { unreadCount: () => 0, list: () => [], markRead: () => undefined, markAllRead: () => undefined, dismissAll: () => undefined } as never;
const projects = { list: () => [], get: () => undefined } as never;
const settings = {
  read: () => ({ ...appSettings }),
  write: (partial: Record<string, unknown>) => Object.assign(appSettings, partial),
  getTaskConnectorIds: () => [],
} as never;

const service = new RemoteAccessService(db, agentStub, notifications, projects, settings, runtime);
const commands = new RemoteTaskCommandService(db, agentStub, settings, projects, join(root, "uploads"), undefined, undefined, runtime);
const events = new RemoteEventBus();
const devices = new RemoteDeviceStore(join(root, "devices.json"));
const pairing = new RemoteAccessPairing(devices, 60_000);

try {
  db.upsertTask({ id: TASK, title: "ACP Remote Test", updatedAt: Date.now() });
  const token = devices.issue("Android ACP").token;
  const server = new RemoteAccessServer({
    port: 0, devices, pairing, service, commands, events,
  });
  const address = await server.start();
  const client = new RemoteClient(`http://127.0.0.1:${address.port}`, token);
  try {
    // ---------- 1. 目录投影 ----------
    const agents = await client.acpAgents();
    assert.deepEqual(agents.map((agent) => agent.id), ["devin", "codex"], "停用的 Agent（claude）不投影到手机端");
    assert.equal(agents[0]!.available, true);
    assert.equal(agents[1]!.available, false, "未安装 CLI 的 Agent 保留并标记不可用");
    assert.equal(agents[1]!.detail, "未检测到 codex CLI");
    assert.equal(agents[0]!.permissionPolicy, "auto-allow", "手机端必须能看到「这个 Agent 不会再打断我」");
    assert.equal(agents[1]!.permissionPolicy, "ask", "未配置策略默认 ask");
    ok("GET /v1/acp/agents 投影已启用 Agent 并标记不可用项");

    const bootstrap = await client.bootstrap();
    assert.equal(bootstrap.acpAgents?.length, 2, "bootstrap 一并下发 ACP 目录（首屏即可用）");
    ok("bootstrap 携带 acpAgents 目录");

    // ---------- 1.5 权限策略：手机端可改，写进电脑端设置 ----------
    const updated = await client.setAcpPermission("devin", "auto-deny");
    assert.equal(updated.find((agent) => agent.id === "devin")?.permissionPolicy, "auto-deny");
    assert.equal(appSettings.externalAgentPermissionPolicies.devin, "auto-deny", "策略必须落到电脑端设置");
    await client.setAcpPermission("devin", "ask");
    assert.equal(
      "devin" in appSettings.externalAgentPermissionPolicies,
      false,
      "ask 是默认值，不应留在配置里（避免配置漂移）",
    );
    await expectApiError(client.setAcpPermission("nope", "auto-allow"), 400, "未知 Agent 改策略 → 400");
    await expectApiError(client.setAcpPermission("devin", "allow-everything" as never), 400, "非法策略值 → 400");
    await client.setAcpPermission("devin", "auto-allow");
    ok("POST /v1/acp/agents/:id/permission 修改权限策略（含非法输入拒绝）");

    // ---------- 2. 拒绝路径 ----------
    await expectApiError(client.acpPrompt(TASK, { agentId: "nope", text: "hi" }), 400, "未知 Agent → 400");
    await expectApiError(client.acpPrompt(TASK, { agentId: "codex", text: "hi" }), 400, "不可用 Agent → 400");
    await expectApiError(client.acpPrompt(TASK, { agentId: "claude", text: "hi" }), 400, "已停用 Agent → 400");
    await expectApiError(client.acpPrompt(TASK, { agentId: "devin", text: "   " }), 400, "空消息 → 400");
    assert.equal(runtime.history(TASK).runs.length, 0, "被拒绝的请求不得产生 ACP run");
    ok("无效委托全部在落库前拒绝");

    // ---------- 3. 真实执行 + 权限审批 ----------
    const started = await client.acpPrompt(TASK, { agentId: "devin", text: "在项目里建一个文件" });
    assert.equal(started.run.agentId, "devin");
    assert.equal(started.run.protocol, "acp");
    assert.ok(["starting", "working", "blocked"].includes(started.run.status), `run 应处于执行态，实际 ${started.run.status}`);
    assert.ok(started.userMessageId && started.assistantMessageId);
    ok("POST /v1/tasks/:id/acp 启动真实 ACP 进程并返回 run 投影");

    // 同任务并发：必须 409（两个 Agent 不能同时改同一个 cwd）
    await expectApiError(client.acpPrompt(TASK, { agentId: "devin", text: "并发" }), 409, "同任务并发委托 → 409");

    const snapshot = await waitFor(() => {
      const current = service.runtime(TASK);
      return current && current.acpRun ? current : undefined;
    }, "runtime acpRun");
    assert.equal(snapshot.acpRun?.agentId, "devin");
    assert.equal(snapshot.busy, true, "ACP 执行中任务必须显示 busy（否则手机端还能继续发）");
    ok("runtime() 暴露 acpRun 且 busy=true");

    // 权限请求：pendingActions 里必须有 acp 审批 + Agent 声明的选项
    const withPermission = await waitFor(() => {
      const current = service.runtime(TASK);
      const action = current?.pendingActions.find((item) => item.approvalKind === "acp");
      return action ? { current: current!, action } : undefined;
    }, "ACP permission request");
    assert.equal(withPermission.action.toolCallId, "permission-tool");
    assert.equal(withPermission.action.acpRunId, started.run.runId);
    assert.deepEqual(withPermission.action.acpPermissionOptions?.map((option) => option.optionId), ["allow", "reject"], "审批选项必须来自 Agent 声明");
    assert.equal(withPermission.action.dangerous, false);
    ok("ACP 权限请求进入 pendingActions（approvalKind=acp + 真实选项）");

    const tasksDuring = await client.bootstrap();
    const row = tasksDuring.tasks.find((task) => task.id === TASK)!;
    assert.equal(row.pendingActionCount >= 1, true, "任务行必须显示待审批计数");
    assert.equal(row.busy, true, "任务行必须显示执行中（ACP 也算 busy）");
    ok("任务列表的 busy / pendingActionCount 纳入 ACP 运行");

    // 无效 optionId 必须 400，有效 optionId 才放行
    await expectApiError(
      client.approve(TASK, "permission-tool", { decision: "allow-once", optionId: "not-a-real-option" }),
      400,
      "无效 ACP 选项 → 400",
    );
    await client.approve(TASK, "permission-tool", { decision: "allow-once", optionId: "allow" });
    ok("回传 Agent 的 optionId 放行 ACP 权限请求");

    // 审批失效后再点一次 → 409（不是静默成功）
    await expectApiError(
      client.approve(TASK, "permission-tool", { decision: "allow-once", optionId: "allow" }),
      409,
      "重复/失效审批 → 409",
    );

    // 等的是"终态"，不是"文本到了"：输出流先落地、run 投影随后才从 working 变 completed，
    // 只判文本会在慢机器上偶发红（CI 上出现过 actual 'working' / expected 'completed'）。
    const history = await waitFor(async () => {
      const value = await client.history(TASK);
      const message = value.messages.find((item) => item.id === started.assistantMessageId);
      return message && /permission-selected-allow/.test(message.text) && message.acp?.status === "completed"
        ? value
        : undefined;
    }, "ACP completion");
    const assistant = history.messages.find((item) => item.id === started.assistantMessageId)!;
    assert.match(assistant.text, /mock-chunk/, "手机端能看到 ACP 的真实输出");
    assert.match(assistant.text, /permission-selected-allow/, "权限选择结果回到 Agent");
    assert.equal(assistant.acp?.agentId, "devin");
    assert.equal(assistant.acp?.status, "completed");
    assert.equal(assistant.acp?.resumeSupported, true, "mock Agent 声明了 resume 能力");
    ok("history() 合入 ACP 轮次并携带 acp 运行投影");

    const doneRuntime = service.runtime(TASK)!;
    assert.equal(doneRuntime.busy, false);
    assert.equal(doneRuntime.acpRun, null, "结束后不再显示活着的 ACP run");
    assert.equal(doneRuntime.pendingActions.filter((item) => item.approvalKind === "acp").length, 0);
    ok("结束后 runtime 清理 acpRun 与 ACP 审批");

    // ---------- 4. 续聊 ----------
    await waitIdle();
    const resumed = await client.acpPrompt(TASK, {
      agentId: "devin",
      text: "继续上一轮",
      continueFromRunId: started.run.runId,
    });
    // continuationMode 由 Runtime 在 session/resume 成功后才落库：轮询到它证明真的走了 resume，
    // 而不是降级新建 session（降级会是 "new"）。
    const resumeMode = await waitFor(async () => {
      const value = await client.history(TASK);
      return value.messages.find((item) => item.id === resumed.assistantMessageId)?.acp?.continuationMode;
    }, "resume continuation mode");
    assert.equal(resumeMode, "resume", "同 Agent 续聊走 resume");
    const resumePermission = await waitFor(() => {
      const current = service.runtime(TASK);
      return current?.pendingActions.find((item) => item.approvalKind === "acp");
    }, "resume permission");
    await client.approve(TASK, resumePermission.toolCallId, { decision: "deny", optionId: "reject" });
    ok("续聊轮次的权限请求同样可审批");

    const resumedHistory = await waitFor(async () => {
      const value = await client.history(TASK);
      const message = value.messages.find((item) => item.id === resumed.assistantMessageId);
      // Streamed text can arrive before the terminal run projection. Wait for
      // the behavior asserted below, rather than racing the settlement event.
      return message?.acp?.status === "completed" && /permission-selected-reject/.test(message.text) ? value : undefined;
    }, "resume completion");
    assert.match(resumedHistory.messages.find((item) => item.id === resumed.assistantMessageId)!.text, /permission-selected-reject/);
    ok("续聊轮次完成并记录拒绝结果");

    // 不传任何续聊字段：手机端默认自动续接（进程会新起，但 session 上下文延续）
    await waitIdle();
    const auto = await client.acpPrompt(TASK, { agentId: "devin", text: "自动续接一轮" });
    const autoMode = await waitFor(async () => {
      const value = await client.history(TASK);
      return value.messages.find((item) => item.id === auto.assistantMessageId)?.acp?.continuationMode;
    }, "auto continuation mode");
    assert.equal(autoMode, "resume", "缺省必须自动续接上一轮 session，而不是每次清空上下文");
    const autoPermission = await waitFor(() => {
      const current = service.runtime(TASK);
      return current?.pendingActions.find((item) => item.approvalKind === "acp");
    }, "auto permission");
    await client.approve(TASK, autoPermission.toolCallId, { decision: "deny", optionId: "reject" });
    await waitFor(async () => {
      const value = await client.history(TASK);
      return value.messages.find((item) => item.id === auto.assistantMessageId)?.acp?.status === "completed";
    }, "auto completion");
    ok("缺省自动续接会话（resume）");

    // newSession: true 强制开新会话（丢弃上下文）
    await waitIdle();
    const fresh = await client.acpPrompt(TASK, { agentId: "devin", text: "强制新会话", newSession: true });
    const freshMode = await waitFor(async () => {
      const value = await client.history(TASK);
      return value.messages.find((item) => item.id === fresh.assistantMessageId)?.acp?.continuationMode;
    }, "newSession continuation mode");
    assert.equal(freshMode, "new", "newSession=true 必须新建 session");
    const freshPermission = await waitFor(() => {
      const current = service.runtime(TASK);
      return current?.pendingActions.find((item) => item.approvalKind === "acp");
    }, "fresh permission");
    await client.approve(TASK, freshPermission.toolCallId, { decision: "deny", optionId: "reject" });
    await waitFor(async () => {
      const value = await client.history(TASK);
      return value.messages.find((item) => item.id === fresh.assistantMessageId)?.acp?.status === "completed";
    }, "fresh completion");
    ok("newSession=true 强制新会话");

    // 续聊目标不存在 → 降级为新 session（不报错、也不串到别的 run）
    await waitIdle();
    const fallback = await client.acpPrompt(TASK, { agentId: "devin", text: "降级一轮", continueFromRunId: "does-not-exist" });
    assert.ok(fallback.run.runId !== started.run.runId);
    const fallbackMode = await waitFor(async () => {
      const value = await client.history(TASK);
      return value.messages.find((item) => item.id === fallback.assistantMessageId)?.acp?.continuationMode;
    }, "fallback continuation mode");
    assert.equal(fallbackMode, "new", "无效 runId 的续聊必须降级为 new");
    await client.abort(TASK);
    ok("无效 runId 的续聊降级为新 session");

    // ---------- 5. 停止 ----------
    const stopped = await waitFor(() => {
      const current = service.runtime(TASK)!;
      return current.busy === false && !current.acpRun ? current : undefined;
    }, "abort clears acp run");
    assert.equal(stopped.busy, false);
    const lastRun = runtime.history(TASK).runs.at(-1)!;
    assert.equal(lastRun.status, "cancelled", "abort 必须真正取消 ACP 进程（不只是内置 Pi）");
    ok("POST /abort 同时取消 ACP 外部 Agent");

    // ---------- 5.5 新任务直接交给 ACP（首页选中 Agent 的第一轮） ----------
    const created = await client.createAcpTask({
      agentId: "devin",
      text: "新任务第一轮交给 ACP",
      welcomeMode: "coding",
    });
    assert.match(created.task.id, /^remote-/, "电脑端落库新任务并返回");
    assert.equal(created.task.title, "新任务第一轮交给 ACP");
    assert.equal(created.run.agentId, "devin");
    assert.equal(created.task.busy, true, "新任务首轮就标记执行中");
    const createdSnapshot = await waitFor(() => {
      const current = service.runtime(created.task.id);
      return current?.acpRun ? current : undefined;
    }, "created task acp run");
    assert.equal(createdSnapshot.acpRun?.agentId, "devin");
    const createdPermission = await waitFor(() => {
      const current = service.runtime(created.task.id);
      return current?.pendingActions.find((item) => item.approvalKind === "acp");
    }, "created task permission");
    await client.approve(created.task.id, createdPermission.toolCallId, { decision: "deny", optionId: "reject" });
    const createdDone = await waitFor(async () => {
      const value = await client.history(created.task.id);
      const message = value.messages.find((item) => item.id === created.assistantMessageId);
      return message && /permission-selected-reject/.test(message.text) ? value : undefined;
    }, "created task completion");
    assert.equal(createdDone.messages.find((item) => item.id === created.assistantMessageId)?.acp?.status, "completed");
    await client.deleteTask(created.task.id);
    ok("POST /v1/tasks + acpAgentId 直接创建并执行 ACP 任务");

    // 新建路径同样拒绝不可用 Agent，且不留下半创建任务
    const beforeTasks = db.listNonTrashedTasks().length;
    await expectApiError(client.createAcpTask({ agentId: "codex", text: "x", welcomeMode: "coding" }), 400, "新任务 + 不可用 Agent → 400");
    assert.equal(db.listNonTrashedTasks().length, beforeTasks, "失败的新任务不得残留任务行");
    ok("新任务 ACP 失败回滚（无半创建任务）");

    // ---------- 6. 纯函数 / 投影 ----------
    const ranked = liveAcpRunForTask([
      { ...runtime.history(TASK).runs[0]!, status: "working", startedAt: 10, taskId: "other" } as never,
      { ...runtime.history(TASK).runs[0]!, status: "completed", startedAt: 20, taskId: TASK } as never,
    ], TASK);
    assert.equal(ranked, undefined, "已结束的同任务 run 不算 live");
    const mapped = mapRemoteAcpRun(runtime.history(TASK).runs[0]!);
    assert.equal(mapped.agentId, "devin");
    assert.ok(mapped.commandLabel.length > 0, "投影必须带上电脑端实际命令标签，便于排查");
    assert.equal("cwd" in mapped, false, "ACP 投影不得泄漏电脑端路径");
    ok("mapRemoteAcpRun / liveAcpRunForTask 语义正确");

    // ---------- 7. 手机端 store 提交语义 ----------
    const realFetch = globalThis.fetch;
    let captured: { url: string; method?: string; body?: unknown } | null = null;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/v1/tasks") && method === "POST") {
        captured = { url, method, body };
        return Promise.resolve(new Response(JSON.stringify({
          task: { id: "t-new", title: "新任务", archived: false, updatedAt: Date.now(), busy: true, pendingActionCount: 0 },
          run: { runId: "r-new", agentId: "devin", agentName: "Devin", protocol: "acp", status: "starting", sessionReady: false, resumeSupported: false, cancelSupported: true, recoveryState: "none", verificationStatus: "not_verified", commandLabel: "mock-acp" },
          userMessageId: "u-new", assistantMessageId: "a-new",
        }), { status: 201, headers: { "content-type": "application/json" } }));
      }
      if (url.endsWith("/v1/tasks/t-store/acp")) {
        captured = { url, method, body };
        return Promise.resolve(new Response(JSON.stringify({
          run: { runId: "r-store", agentId: "devin", agentName: "Devin", protocol: "acp", status: "starting", sessionReady: false, resumeSupported: false, cancelSupported: true, recoveryState: "none", verificationStatus: "not_verified", commandLabel: "mock-acp" },
          userMessageId: "u-store", assistantMessageId: "a-store",
        }), { status: 202, headers: { "content-type": "application/json" } }));
      }
      if (url.endsWith("/v1/tasks/t-store/actions/tc-1/respond")) {
        captured = { url, method, body };
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.endsWith("/v1/tasks/t-store/history")) {
        return Promise.resolve(new Response(JSON.stringify({ taskId: "t-store", messages: [] }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (url.endsWith("/v1/tasks/t-store/runtime")) {
        return Promise.resolve(new Response(JSON.stringify({ taskId: "t-store", busy: true, interactions: [], activeGoal: null, pendingActions: [], acpRun: null }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      return Promise.reject(new TypeError("unexpected fetch " + url));
    }) as typeof fetch;
    try {
      useRemoteStore.setState({
        client: new RemoteClient("http://127.0.0.1:9", "stub"),
        activeTaskId: "t-store", sending: false, live: {}, runtimes: {},
        selectedAcpAgentId: "devin", attachments: [],
      });
      await useRemoteStore.getState().sendAcp("派给 Devin", []);
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:9/v1/tasks/t-store/acp",
        method: "POST",
        body: { agentId: "devin", text: "派给 Devin" },
      }, "sendAcp 必须命中 ACP 路由且只下发契约字段");
      const liveState = useRemoteStore.getState().live["t-store"]!;
      assert.equal(liveState["u-store"]?.text, "派给 Devin", "提交成功后用户气泡立即落地");
      assert.equal(liveState["a-store"]?.streaming, true);
      assert.equal(liveState["a-store"]?.acp?.agentId, "devin", "流式助手气泡一开始就带 ACP 归属");
      assert.equal(useRemoteStore.getState().sending, false);
      ok("store.sendAcp 命中 ACP 路由并乐观落气泡");

      await useRemoteStore.getState().resolveAcpPermission("tc-1", "allow");
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:9/v1/tasks/t-store/actions/tc-1/respond",
        method: "POST",
        body: { decision: "allow-once", optionId: "allow" },
      }, "ACP 审批必须回传 optionId");
      ok("store.resolveAcpPermission 回传 optionId");

      // 「下一轮开新会话」开关：必须下发 newSession，且只对一轮生效
      captured = null;
      useRemoteStore.setState({ acpNewSession: true });
      await useRemoteStore.getState().sendAcp("清空上下文", []);
      assert.deepEqual((captured as unknown as { body: unknown }).body, { agentId: "devin", text: "清空上下文", newSession: true });
      assert.equal(useRemoteStore.getState().acpNewSession, false, "一次性开关用后必须复位");
      ok("store.sendAcp 支持 newSession（一次性）");

      // 新任务第一轮交给 ACP：必须一次请求同时落任务与 run
      captured = null;
      useRemoteStore.setState({
        client: new RemoteClient("http://127.0.0.1:9", "stub"),
        activeTaskId: null, creating: false, live: {}, runtimes: {},
        selectedAcpAgentId: "devin", selectedWelcomeMode: "coding", selectedModePresetId: "dev",
        bootstrap: {
          taskModes: [{ id: "coding", label: "代码开发", tags: [{ id: "dev", label: "开发" }] }],
          spaces: [], projects: [],
        } as never,
      });
      await useRemoteStore.getState().createAcp("新任务交给 Devin", []);
      assert.deepEqual(captured, {
        url: "http://127.0.0.1:9/v1/tasks",
        method: "POST",
        body: { acpAgentId: "devin", text: "新任务交给 Devin", welcomeMode: "coding", modePresetId: "dev" },
      }, "createAcp 必须在创建请求里带 acpAgentId");
      assert.equal(useRemoteStore.getState().activeTaskId, "t-new", "创建成功立即进入新任务");
      assert.equal(useRemoteStore.getState().live["t-new"]?.["u-new"]?.text, "新任务交给 Devin");
      assert.equal(useRemoteStore.getState().live["t-new"]?.["a-new"]?.acp?.agentName, "Devin");
      assert.equal(useRemoteStore.getState().selectedAcpAgentId, "devin", "ACP 选择保持粘性（下一轮还是它）");
      assert.equal(useRemoteStore.getState().selectedModePresetId, null, "Tag 属于一次性选择，提交后复位");
      ok("store.createAcp 新任务直达 ACP 且选择复位语义正确");
    } finally {
      globalThis.fetch = realFetch;
      useRemoteStore.setState({ client: null, activeTaskId: null, sending: false, live: {}, runtimes: {}, selectedAcpAgentId: null });
    }

    // ---------- 8. 路由层：Origin / 认证仍然生效 ----------
    assert.equal(await httpJson(address.port, "GET", "/v1/acp/agents", {}), 401, "ACP 目录同样要求设备认证");
    assert.equal(await httpJson(address.port, "GET", "/v1/acp/agents", { origin: "http://evil.example" }), 403, "ACP 路由同样受 Origin 白名单管控");
    assert.equal(
      await httpJson(address.port, "POST", `/v1/tasks/${TASK}/acp`, {
        authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://localhost",
      }, JSON.stringify({ agentId: "devin", text: "hi", extra: true })),
      400,
      "ACP payload 严格校验（未知字段拒绝）",
    );
    ok("ACP 路由沿用认证 / Origin / strict schema 护栏");

    assert.ok(uiEvents.some((event) => event.type === "tool_start"), "ACP 事件确实流经 setSend（手机端 SSE 来源）");
    ok("ACP 流式事件经 setSend 输出");
  } finally {
    await server.stop();
  }
  console.log(`\nremote ACP: PASS (${passed} checks)`);
} finally {
  // 取消是异步的（先 notify 再 kill，给适配器 ~1.2s 收尾）：必须等 run 真正结束再关库，
  // 否则 execute() 的收尾写入会撞上已关闭的 SQLite 连接。
  runtime.dispose();
  await waitFor(() => runtime.active().length === 0 ? true : undefined, "ACP runs settle", 10_000).catch(() => undefined);
  await sleep(300);
  db.close();
  rmSync(root, { recursive: true, force: true });
}
