/** Actual process death between Gateway admission and native completion. All
 * accounts, models, tools, database files and replies are private fixtures. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { GatewayReplyNotSentError, type GatewayReplyRestoreInput } from "../src/main/gateway/GatewayReply";
import type { GatewayInboundHandler, GatewayInboundMessage } from "../src/main/gateway/channels";

const childMode = process.argv[2] === "--crash-child";
const root = childMode ? process.argv[3]! : mkdtempSync(join(tmpdir(), "gateway-inbox-crash-"));
process.env.HOME = root; process.env.USERPROFILE = root; process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");
const agentDir = join(root, ".mybuddy"), mcpDir = join(agentDir, "plugins", "mcp");
mkdirSync(mcpDir, { recursive: true });
writeFileSync(join(mcpDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
const effectFile = join(root, "unsafe-effects.txt"), repliesFile = join(root, "provider-replies.txt");
const until = async (check: () => boolean, timeout = 30_000) => {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("Gateway hard-crash fixture timeout"); await new Promise(resolve => setTimeout(resolve, 10)); }
};

class FixtureTelegram {
  readonly id = "telegram-default";
  readonly type = "telegram" as const;
  readonly name = "Telegram fixture";
  readonly key = "a".repeat(64);
  live = true;
  generation = 1;
  inbound!: GatewayInboundHandler;
  setInboundHandler(handler: GatewayInboundHandler) { this.inbound = handler; }
  isConnected = () => this.live;
  statusText = () => "fixture";
  workConnectionKey = () => this.live ? this.key : undefined;
  gatewayConnectionGeneration = () => this.generation;
  connect = async () => { this.live = true; };
  disconnect = async () => { this.live = false; this.generation++; };
  restoreGatewayReply(input: GatewayReplyRestoreInput) {
    assert.equal(input.route?.kind, "telegram");
    assert.equal(input.chatId, "100");
    const generation = this.generation;
    return async (text: string) => {
      if (!this.live || generation !== this.generation) throw new GatewayReplyNotSentError("fixture replaced");
      appendFileSync(repliesFile, JSON.stringify({ messageId: input.messageId, text }) + "\n");
    };
  }
  message(id: string, text: string): GatewayInboundMessage {
    const route = { kind: "telegram", chatId: "100", replyToMessageId: Number(id) } as const;
    return { channelId: this.id, chatId: "100", messageId: id, text, sender: { id: "owner" }, replyRoute: route,
      reply: this.restoreGatewayReply({ deliveryId: "fixture", chatId: "100", messageId: id, route }) };
  }
}

function runtime() {
  const db = new AppDatabase(join(agentDir, "app.db"));
  const model: any = { provider: "fixture", id: "native", name: "fixture", api: "openai-completions", reasoning: false,
    input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const hold = defineTool({ name: "crash_fixture_effect", description: "isolated unsafe effect", parameters: Type.Object({}), replay: "unsafe",
    execute: async () => {
      appendFileSync(effectFile, "effect\n");
      await new Promise<void>(() => {}); // Killed by the test parent, never a real external operation.
      return { output: [{ type: "text" as const, text: "done" }] };
    } });
  const models: any = { getAuth: async () => undefined, refresh: async () => {}, getAvailable: async () => [model], getModel: () => model,
    streamSimple: (_model: unknown, context: any) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const index = context.messages.findLastIndex((message: any) => message.role === "user"), input = context.messages[index];
        const text = typeof input.content === "string" ? input.content : input.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
        const afterTool = context.messages.slice(index + 1).some((message: any) => message.role === "toolResult");
        const content: any = text === "HOLD" && !afterTool ? [{ type: "toolCall", id: "crash-tool", name: "crash_fixture_effect", arguments: {} }]
          : [{ type: "text", text: "ANSWER:" + text }];
        const stopReason = content[0].type === "toolCall" ? "toolUse" : "stop";
        const answer: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), usage, stopReason };
        stream.push({ type: "done", reason: stopReason, message: answer }); stream.end();
      });
      return stream;
    } };
  models.completeSimple = (model: any, context: any, options: any) => models.streamSimple(model, context, options).result();
  const durable = new DurableBotService({ db, models, agentDir, mcpDir, defaultModel: () => "fixture/native", toolMode: () => "native",
    instructions: () => "fixture", tools: async () => ({ tools: [hold], contextHooks: [] }), emit: () => {},
    resolveCwd: () => { const path = join(root, "task-workspace"); mkdirSync(path, { recursive: true }); return path; } });
  const adapter = new FixtureTelegram();
  const gateway = new GatewayService(db, { runGatewayTurn: request => durable.runGatewayTurn(request) }, undefined, {
    adapters: { telegram: adapter as never }, settingsStore: { read: () => ({ defaultModelId: "fixture/native" }) as never },
  });
  // The transport fixture is pre-authenticated; no network/config secrets are involved.
  (gateway as any).channelPolicies.set(adapter.id, { allowUsers: ["owner"] });
  return { db, durable, gateway, adapter };
}

if (childMode) {
  // Keep IPC referenced while the unsafe fixture is suspended.
  process.on("message", () => {});
  const active = runtime();
  const first = active.adapter.inbound(active.adapter.message("1", "HOLD"));
  const queued = active.adapter.inbound(active.adapter.message("2", "QUEUED"));
  await Promise.all([first.accepted, queued.accepted]);
  await until(() => existsSync(effectFile));
  const rows = active.db.connection.prepare("SELECT message_id,status FROM gateway_inbox ORDER BY rowid").all();
  assert.deepEqual(rows, [{ message_id: "1", status: "running" }, { message_id: "2", status: "pending" }]);
  process.send?.({ ready: true, rows });
} else {
  let child: ChildProcess | undefined;
  let active: ReturnType<typeof runtime> | undefined;
  try {
    child = fork(fileURLToPath(import.meta.url), ["--crash-child", root], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let logs = "";
    child.stdout?.on("data", bytes => { logs = (logs + String(bytes)).slice(-16_000); });
    child.stderr?.on("data", bytes => { logs = (logs + String(bytes)).slice(-16_000); });
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("child did not reach committed crash boundary: " + logs)), 30_000);
      child!.once("error", error => { clearTimeout(timer); rejectReady(error); });
      child!.once("exit", code => { clearTimeout(timer); rejectReady(new Error("child exited before crash boundary: " + code + " " + logs)); });
      child!.on("message", value => { if ((value as { ready?: boolean }).ready) { clearTimeout(timer); resolveReady(); } });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL"); await exited;
    assert.equal(readFileSync(effectFile, "utf8"), "effect\n");
    assert.equal(existsSync(repliesFile), false);
    active = runtime();
    const accepted = active.db.connection.prepare("SELECT message_id,status FROM gateway_inbox ORDER BY rowid").all();
    assert.deepEqual(accepted, [{ message_id: "1", status: "pending" }, { message_id: "2", status: "pending" }]);
    (active.gateway as any).platforms.resume(active.adapter.id);
    await until(() => (active!.db.connection.prepare("SELECT COUNT(*) AS count FROM gateway_inbox WHERE status='completed'").get() as { count: number }).count === 2);
    assert.equal(readFileSync(effectFile, "utf8"), "effect\n", "the native unsafe tool must not execute a second time after SIGKILL");
    const replies = readFileSync(repliesFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(replies, [{ messageId: "1", text: "ANSWER:HOLD" }, { messageId: "2", text: "ANSWER:QUEUED" }]);
    await active.adapter.inbound(active.adapter.message("1", "HOLD"));
    await active.adapter.inbound(active.adapter.message("2", "QUEUED"));
    assert.equal(readFileSync(repliesFile, "utf8").trim().split("\n").length, 2, "platform redelivery uses terminal inbox receipts");
    assert.deepEqual(active.db.connection.prepare("SELECT message_id,retry_count FROM gateway_inbox ORDER BY rowid").all(),
      [{ message_id: "1", retry_count: 2 }, { message_id: "2", retry_count: 1 }]);
    console.log("PASS actual SIGKILL: committed Gateway FIFO survives; running native receipt resumes without repeating unsafe effect; replies and redelivery dedupe remain stable");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (active) { await active.gateway.stop(); await active.durable.close(); active.db.close(); }
    rmSync(root, { recursive: true, force: true });
  }
}
