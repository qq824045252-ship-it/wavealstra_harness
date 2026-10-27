/**
 * test:acp-dsh-live — DeepSeek Harness 的 ACP **真机**冒烟（不使用任何 mock agent）。
 *
 * 与 `test:acp-runtime` 的分工：那条用假 agent 验 MyBuddy 自己的 ACP 客户端逻辑（协议映射、
 * 权限、取消、崩溃恢复）；这条真拉起 `dsh --profile acp`，验**对端**的实际契约——
 * 协议版本、能力声明、configOptions 形状（dsh 的模型选择是 optgroup）、跨进程 resume、
 * 以及一轮真实 prompt 能不能拿到 `end_turn`。
 *
 * 归 NETWORK 类（在 scripts/test-all.mjs 里显式登记）：需要真实 CLI + 凭据 + 网络，
 * 只在 `--include-live` 时跑，不进 default 门禁。缺 CLI 时整条 SKIP（exit 0）。
 *
 * 凭据：dsh 自己从 `~/.dsh/.credentials.yaml` / 环境变量取 key，本用例不碰任何密钥，
 * 只在"某条模型路由可用"时做真实 prompt。全部路由都缺 key 时 prompt 部分打 SKIP，
 * 协议部分仍然照常断言——这样 CI/新机器上不会因为没配 key 就红。
 *
 * 副作用：会像正常使用 dsh 一样在 `~/.dsh/sessions` 留一条会话记录，并在给定 cwd 下
 * 让 dsh 工作（本用例用临时目录）；结束时 `session/close`。
 *
 * 运行：`pnpm -s test:acp-dsh-live`（GUARD_HOME=host，需要真实家目录里的凭据）
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CMD = "dsh";
const ARGS = ["--profile", "acp"];
const TURN_TIMEOUT_MS = 240_000;

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type ConfigValue = { value: string; name?: string; group?: string };
type ConfigOption = {
  id: string;
  name: string;
  type?: string;
  category?: string;
  currentValue?: unknown;
  options?: Array<ConfigValue & { options?: ConfigValue[] }>;
};

function ok(label: string, detail?: string): void {
  console.log(`PASS ${label}${detail ? `  — ${detail}` : ""}`);
}

function skip(label: string, reason: string): void {
  console.log(`SKIP ${label}  — ${reason}`);
}

/** ACP 的 select 选项可能是 optgroup（dsh 的 model 就是这样），按产品侧同样规则展平。 */
function flattenOptions(options: ConfigOption["options"]): ConfigValue[] {
  const out: ConfigValue[] = [];
  for (const item of Array.isArray(options) ? options : []) {
    if (item && Array.isArray(item.options)) {
      const group = typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
      for (const child of item.options) {
        if (child && typeof child.value === "string" && typeof child.name === "string") {
          out.push({ value: child.value, name: child.name, ...(group ? { group } : {}) });
        }
      }
    } else if (item && typeof item.value === "string") {
      out.push({ value: item.value, name: String(item.name ?? item.value), ...(item.group ? { group: item.group } : {}) });
    }
  }
  return out;
}

class AgentProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: JsonRpcMessage) => void>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private readonly updates: string[] = [];
  private permissionRequests = 0;
  private readonly permissionAnswer: (options: Array<{ optionId?: string; name?: string }>) => string | undefined;

  constructor(cwd: string, permissionAnswer: AgentProcess["permissionAnswer"] = () => undefined) {
    this.permissionAnswer = permissionAnswer;
    this.child = spawn(CMD, ARGS, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows 上 dsh 是 .cmd shim，必须过 shell 才能 spawn。
      shell: process.platform === "win32",
    }) as ChildProcessWithoutNullStreams;
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const resolve = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          resolve(message);
          continue;
        }
        if (message.method === "session/update") {
          const update = (message.params?.update ?? {}) as { sessionUpdate?: string };
          if (typeof update.sessionUpdate === "string") this.updates.push(update.sessionUpdate);
        } else if (message.method === "session/request_permission") {
          this.permissionRequests += 1;
          const options = ((message.params?.options ?? []) as Array<{ optionId?: string; name?: string }>);
          const answer = this.permissionAnswer(options);
          this.child.stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { outcome: answer ? { outcome: "selected", optionId: answer } : { outcome: "cancelled" } },
            })}\n`,
          );
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  updateCount(): number { return this.updates.length; }
  permissionCount(): number { return this.permissionRequests; }
  stderrTail(): string { return this.stderr.trim().split("\n").slice(-3).join(" | "); }
  dispose(): void { this.child.kill(); }
}

/** 探一下 CLI 在不在（不在就整条 SKIP，而不是红）。 */
function cliAvailable(): boolean {
  try {
    const probe = spawn(CMD, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    return probe.pid !== undefined;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  if (!cliAvailable()) {
    skip("dsh ACP 真机冒烟", `未找到 ${CMD} CLI（npm install -g @deepseek-ai/dsh）`);
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "mybuddy-acp-dsh-live-"));

  // ---------- 1. 协议层：initialize / session-new / configOptions ----------
  const first = new AgentProcess(cwd);
  let sessionId = "";
  let modelOption: ConfigOption | undefined;
  try {
    const initialized = await first.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    assert.ok(!initialized.error, `initialize 失败：${initialized.error?.message ?? "unknown"}`);
    const init = (initialized.result ?? {}) as {
      protocolVersion?: number;
      agentInfo?: { name?: string; version?: string };
      agentCapabilities?: { sessionCapabilities?: Record<string, unknown> };
    };
    assert.equal(init.protocolVersion, 1, "ACP 协议版本必须是 1（v1 over stdio）");
    ok("initialize 返回 protocolVersion=1");
    assert.ok(init.agentInfo?.name, "agentInfo.name 必须存在（设置页要显示对端身份）");
    ok("agentInfo 自报身份", `${init.agentInfo?.name} ${init.agentInfo?.version ?? ""}`.trim());
    assert.ok(
      init.agentCapabilities?.sessionCapabilities?.resume,
      "dsh 应声明 sessionCapabilities.resume（MyBuddy 续聊依赖它）",
    );
    ok("声明 sessionCapabilities.resume");

    const created = await first.request("session/new", { cwd, mcpServers: [] });
    assert.ok(!created.error, `session/new 失败：${created.error?.message ?? "unknown"}`);
    const session = (created.result ?? {}) as { sessionId?: string; configOptions?: ConfigOption[] };
    sessionId = session.sessionId ?? "";
    assert.ok(sessionId, "session/new 必须返回 sessionId");
    ok("session/new 返回 sessionId", sessionId.slice(0, 8));

    const options = session.configOptions ?? [];
    modelOption = options.find((option) => option.id === "model");
    const effortOption = options.find((option) => option.id === "reasoning_effort");
    assert.ok(modelOption, "必须暴露 model 配置项（否则 UI 无法选模型）");
    assert.equal(modelOption?.type, "select", "model 必须是 select");
    ok("暴露 model 配置项", `category=${modelOption?.category ?? "?"}`);
    assert.ok(effortOption, "必须暴露 reasoning_effort 配置项");
    ok("暴露 reasoning_effort 配置项", `category=${effortOption?.category ?? "?"}`);

    const values = flattenOptions(modelOption?.options);
    assert.ok(values.length > 0, "model 的 optgroup 必须能展平成可选项（UI 下拉靠它）");
    ok("model optgroup 可展平", values.map((item) => `${item.group ?? "-"}/${item.name}`).slice(0, 4).join(", "));
    assert.ok(
      values.some((item) => item.value === modelOption?.currentValue),
      "model.currentValue 必须命中某个可选项，否则下拉回显为空",
    );
    ok("model.currentValue 命中可选项");

    const closed = await first.request("session/close", { sessionId });
    assert.ok(!closed.error, `session/close 失败：${closed.error?.message ?? "unknown"}`);
    ok("session/close 正常返回");
  } finally {
    first.dispose();
  }

  // ---------- 2. 跨进程 resume：新进程接着用同一个会话 ----------
  const second = new AgentProcess(cwd);
  try {
    await second.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const resumed = await second.request("session/resume", { sessionId, cwd, mcpServers: [] });
    assert.ok(!resumed.error, `session/resume 失败：${resumed.error?.message ?? "unknown"}`);
    const resumedOptions = ((resumed.result ?? {}) as { configOptions?: ConfigOption[] }).configOptions ?? [];
    assert.ok(resumedOptions.length > 0, "resume 后必须仍能拿到 configOptions（续聊要能继续选模型）");
    ok("跨进程 resume 成功", resumedOptions.map((option) => option.id).join(", "));
    await second.request("session/close", { sessionId });
  } finally {
    second.dispose();
  }

  // ---------- 3. 真实 prompt：挑一条有凭据的模型路由，跑完一轮 ----------
  const third = new AgentProcess(cwd, (options) => {
    const allow = options.find((option) => /allow/i.test(`${option.optionId ?? ""} ${option.name ?? ""}`));
    return allow?.optionId ?? options[0]?.optionId;
  });
  try {
    await third.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const created = await third.request("session/new", { cwd, mcpServers: [] });
    const session = (created.result ?? {}) as { sessionId?: string; configOptions?: ConfigOption[] };
    const liveSessionId = session.sessionId ?? "";
    const model = (session.configOptions ?? []).find((option) => option.id === "model");
    const candidates = flattenOptions(model?.options);
    const ordered = [
      ...candidates.filter((item) => item.value === model?.currentValue),
      ...candidates.filter((item) => item.value !== model?.currentValue),
    ].slice(0, 4);

    let answered = false;
    for (const candidate of ordered) {
      const set = await third.request("session/set_config_option", {
        sessionId: liveSessionId,
        configId: "model",
        value: candidate.value,
      });
      if (set.error) continue;
      const startedAt = Date.now();
      const turn = await third.request(
        "session/prompt",
        { sessionId: liveSessionId, prompt: [{ type: "text", text: "只回复两个字：收到。不要调用任何工具，不要解释。" }] },
        TURN_TIMEOUT_MS,
      );
      if (turn.error) {
        const message = turn.error.message ?? "";
        if (/no API key|unauthorized|401|credential/i.test(message)) {
          skip(`真实 prompt（${candidate.group ?? "-"}/${candidate.name}）`, `该路由缺凭据：${message.slice(0, 120)}`);
          continue;
        }
        assert.fail(`真实 prompt 失败（${candidate.name}）：${message.slice(0, 200)}`);
      }
      const result = (turn.result ?? {}) as { stopReason?: string };
      assert.equal(result.stopReason, "end_turn", `一轮 prompt 应以 end_turn 结束，实际 ${result.stopReason}`);
      ok(
        "真实 prompt 跑完一轮（无 mock）",
        `${candidate.group ?? "-"}/${candidate.name} · stopReason=end_turn · ${Date.now() - startedAt}ms · 流式更新 ${third.updateCount()} 条 · 权限请求 ${third.permissionCount()} 次`,
      );
      answered = true;
      break;
    }
    if (!answered) skip("真实 prompt 跑完一轮", "所有模型路由都没有可用凭据（配置 DEEPSEEK_API_KEY 或 magpie key 后可跑）");
    await third.request("session/close", { sessionId: liveSessionId }).catch(() => undefined);
  } finally {
    third.dispose();
    // dsh 退出与句柄释放之间有窗口（Windows 上会 EPERM/EBUSY），清理按 best-effort：
    // 留一个临时目录，好过让真机冒烟因为清理失败变红。
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    } catch (error) {
      console.warn(`[acp-dsh-live] 临时目录清理失败（忽略）：${(error as Error).message}`);
    }
  }
}

await main();
console.log("\n[acp-dsh-live] 完成");
