/**
 * fixture-rpc-child.mjs — 模拟 pi `--mode rpc` 子进程协议（真实进程、真实管道）。
 *
 * 支持：
 * - get_state → sessionId/sessionFile（并按 --session-dir/--session-id 落盘会话文件，
 *   使「重启恢复」可被测试）
 * - prompt / steer → 可选延迟（task 含 "SLEEP:" 前缀时延迟该秒数），
 *   然后发 message_end（assistant，含 usage/model/stopReason）→ agent_settled
 * - prompt 含 "FAIL" → message_end stopReason="error" + errorMessage
 * - prompt 含 "NEVER" → 不 settle（测超时）
 * - abort → 立即 agent_settled
 * - extension_ui_request 对话框 → 记录请求并回 cancelled（验证自动应答）
 * - get_session_stats → 计数响应
 */
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_FILE = "fixture-session.jsonl";

function parseArgs(argv) {
  const out = { sessionDir: null, sessionId: null, appendSystemPrompt: null, tools: null, excludeTools: null, stateDelay: 0, model: null, thinking: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session-dir") out.sessionDir = argv[i + 1];
    if (argv[i] === "--session-id") out.sessionId = argv[i + 1];
    if (argv[i] === "--append-system-prompt") out.appendSystemPrompt = argv[i + 1];
    if (argv[i] === "--tools") out.tools = argv[i + 1];
    if (argv[i] === "--exclude-tools") out.excludeTools = argv[i + 1];
    if (argv[i] === "--state-delay") out.stateDelay = Number(argv[i + 1]) || 0;
    if (argv[i] === "--model") out.model = argv[i + 1];
    if (argv[i] === "--thinking") out.thinking = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
let sessionFile = null;
if (args.sessionDir && args.sessionId) {
  sessionFile = join(args.sessionDir, `${args.sessionId}.jsonl`);
  mkdirSync(args.sessionDir, { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ type: "session_info", id: args.sessionId, name: args.sessionId }) + "\n", "utf8");
}

const sentMessages = [];
const settledPrompts = [];
let dialogRequests = 0;
let onlineThinking = null; // set_thinking_level 最近收到的档位

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (raw) => {
  let cmd;
  try {
    cmd = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ type: "response", command: "parse", success: false, error: "bad json" }) + "\n");
    return;
  }
  handle(cmd);
});

function reply(id, command, success, data) {
  process.stdout.write(JSON.stringify({ type: "response", id: id ?? undefined, command, success, data }) + "\n");
}

function handle(cmd) {
  switch (cmd.type) {
    case "get_state":
      // 模拟子代理内扩展发起对话框（宿主必须自动拒绝，否则挂起）
      process.stdout.write(
        JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "allow?", message: "?" }) + "\n",
      );
      // --state-delay：模拟 worker 启动窗口（竞态测试：starting 期间并发调用必须被门禁拦截）
      const respond = () =>
        reply(cmd.id, "get_state", true, {
          sessionId: args.sessionId ?? "fixture-sess",
          sessionFile,
          isStreaming: false,
          sessionName: args.sessionId ?? null,
          model: { id: "fixture-model" },
        });
      if (args.stateDelay > 0) setTimeout(respond, args.stateDelay);
      else respond();
      break;
    case "prompt": {
      const text = String(cmd.message ?? "");
      if (text.includes("CRASH")) {
        // 模拟子代理进程崩溃
        process.exit(7);
      }
      const msg = {
        role: "assistant",
        content: [{ type: "text", text: `FIXTURE_ANSWER:${text.slice(0, 40)}` }],
        usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: { total: 0.001 }, totalTokens: 130 },
        model: "fixture-model",
        stopReason: text.includes("FAIL") ? "error" : "stop",
      };
      if (text.includes("FAIL")) msg.errorMessage = "fixture 注入的错误";
      // 模拟工具执行（transcript tool_end 分支覆盖）
      process.stdout.write(
        JSON.stringify({ type: "tool_execution_start", toolCallId: "call-fx", toolName: "bash", args: { command: "fixture" } }) + "\n",
      );
      process.stdout.write(
        JSON.stringify({ type: "tool_execution_end", toolCallId: "call-fx", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "fx-out" }] } }) + "\n",
      );
      process.stdout.write(JSON.stringify({ type: "message_end", message: msg }) + "\n");
      if (text.includes("NEVER")) return; // 永不 settle（超时测试）
      const delay = text.match(/SLEEP:(\d+)/)?.[1];
      const wait = delay ? Number(delay) * 1000 : 20;
      setTimeout(() => {
        settledPrompts.push(text);
        appendTranscript("assistant", text);
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
      }, wait);
      break;
    }
    case "steer": {
      const text = String(cmd.message ?? "");
      process.stdout.write(JSON.stringify({ type: "response", command: "steer", success: true }) + "\n");
      // 模拟 steer 在下一轮 LLM 前生效：直接发一条 assistant 消息 + settle
      setTimeout(() => {
        process.stdout.write(
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `STEERED:${text.slice(0, 40)}` }], usage: { input: 10, output: 5, cost: { total: 0 }, totalTokens: 15 }, model: "fixture-model", stopReason: "stop" },
          }) + "\n",
        );
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
      }, 30);
      break;
    }
    case "abort":
      process.stdout.write(JSON.stringify({ type: "response", command: "abort", success: true }) + "\n");
      setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n"), 30);
      break;
    case "get_session_stats":
      reply(cmd.id, "get_session_stats", true, {
        sessionFile,
        totalMessages: sentMessages.length,
        tokens: { input: 1000, output: 100, cacheRead: 50, cacheWrite: 0, total: 1150 },
        cost: 0.01,
      });
      break;
    case "set_thinking_level": {
      onlineThinking = String(cmd.level ?? "");
      reply(cmd.id, "set_thinking_level", true, { level: onlineThinking });
      break;
    }
    case "extension_ui_response":
      // 主进程自动应答（cancelled）——记录后忽略
      dialogRequests += 1;
      break;
    case "extension_ui_request":
      // 忽略（仅用于确认宿主自动应答路径）
      break;
    default:
      reply(cmd.id, cmd.type, true, {});
  }
}

function appendTranscript(role, text) {
  if (!sessionFile) return;
  try {
    appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } }) + "\n", "utf8");
  } catch { /* ignore */ }
}

process.on("exit", () => {
  // 供测试断言：写入计数文件（含收到的工具策略与系统提示注入，验证收敛/重注入）
  try {
    const out = join(args.sessionDir ?? ".", `${args.sessionId ?? "fixture"}-counts.json`);
    writeFileSync(
      out,
      JSON.stringify({
        settled: settledPrompts.length,
        dialogs: dialogRequests,
        tools: args.tools,
        excludeTools: args.excludeTools,
        appendSystemPrompt: args.appendSystemPrompt,
        model: args.model,
        thinking: args.thinking,
        onlineThinking,
      }),
      "utf8",
    );
  } catch { /* ignore */ }
});
