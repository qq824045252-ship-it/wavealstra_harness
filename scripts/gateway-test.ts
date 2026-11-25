import { gatewayInboundIdentity } from "../src/main/gateway/gateway-inbound-identity";
/**
 * Gateway 冒烟测试：DB 迁移/消息落库/容量控制、Telegram md→HTML、消息切分、
 * 幂等去重守卫、白名单判断。
 * 运行：pnpm test:gateway（esbuild bundle + node 直跑，不依赖 electron）
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { mdToHtml, splitTelegramText, TelegramChannelAdapter } from "../src/main/gateway/channels";
import {
  createIdempotencyGuard,
  isAllowedUser,
} from "../src/main/gateway/GatewayService";

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

async function dbTest(): Promise<void> {
  console.log("== DB：gateway_messages 迁移/落库/查询 ==");
  const dir = mkdtempSync(join(tmpdir(), "gw-test-"));
  const dbPath = join(dir, "test.db");
  const native = process.argv.includes("--native");
  const runtimeAuditExecutable = native ? locateRuntimeAudit(process.cwd()) : undefined;
  if (native && (!runtimeAuditExecutable || !existsSync(runtimeAuditExecutable))) throw new Error("Rust worker missing");
  const db = new AppDatabase(dbPath, { runtimeAuditExecutable });

  // 空库可查
  assert(db.listGatewayMessages({}).length === 0, "空库 listGatewayMessages 返回 []");

  // 落库
  db.insertGatewayMessage({
    channelId: "telegram-default",
    chatId: "123",
    direction: "in",
    senderId: "456",
    senderName: "alice",
    text: "你好",
    at: 1000,
  });
  db.insertGatewayMessage({
    channelId: "telegram-default",
    chatId: "123",
    direction: "out",
    text: "回复",
    at: 2000,
  });
  db.insertGatewayMessage({
    channelId: "feishu-default",
    chatId: "chat-x",
    direction: "in",
    text: "飞书消息",
    at: 3000,
  });

  let all = db.listGatewayMessages({});
  assert(all.length === 3, "3 条消息全部落库");
  assert(all[0].at === 1000 && all[1].at === 2000 && all[2].at === 3000, "查询按时间升序返回");

  const tg = db.listGatewayMessages({ channelId: "telegram-default", chatId: "123" });
  assert(tg.length === 2, "按 channel+chat 过滤");
  assert(tg[0].senderName === "alice" && tg[0].direction === "in", "sender/direction 字段完整");

  const limited = db.listGatewayMessages({ limit: 1 });
  assert(limited.length === 1 && limited[0].at === 3000, "limit 取最新");

  if (native) {
    db.insertGatewayMessage({ channelId: "telegram-default", chatId: "123", direction: "out", text: "同一时间", at: 2000 });
    db.connection.exec("CREATE TEMP TABLE gateway_messages AS SELECT * FROM main.gateway_messages WHERE 0");
    try {
      const latest = await db.readGatewayMessages({ channelId: "telegram-default", chatId: "123", limit: 2 });
      assert(latest.map(row => `${row.id}:${row.text}`).join(",") === "2:回复,4:同一时间", "Rust 组合筛选并保留相同时间的写入顺序");
      const all = await db.readGatewayMessages({ channelId: "", chatId: "" });
      assert(all[0]?.senderId === "456" && all[0]?.senderName === "alice" &&
        all[3]?.channelId === "feishu-default", "Rust 保留发送者元数据及空筛选的跨渠道历史");
    } finally {
      db.connection.exec("DROP TABLE temp.gateway_messages");
    }
    // A read-only host connection makes a stored row proof that the worker wrote it.
    const nativeMessage = {
      channelId: "telegram-default", chatId: "native", direction: "out" as const,
      senderId: "456", senderName: "alice", text: "worker 写入", at: 4001,
    };
    db.connection.pragma("query_only = ON");
    try {
      let hostRefused = false;
      try {
        db.insertGatewayMessage({ channelId: "telegram-default", chatId: "native", direction: "out", text: "宿主直写", at: 4000 });
      } catch {
        hostRefused = true;
      }
      assert(hostRefused, "宿主连接 query_only 后直接写入被拒绝（夹具自检）");
      await db.writeGatewayMessage(nativeMessage);
      const written = db.listGatewayMessages({ channelId: "telegram-default", chatId: "native" });
      assert(written.length === 1 && written[0].text === "worker 写入" &&
        written[0].senderId === "456" && written[0].senderName === "alice",
      "query_only 下 writeGatewayMessage 仍落库且发送者字段完整（由 Rust 写入）");
      await db.writeGatewayMessage(nativeMessage);
      assert(db.listGatewayMessages({ channelId: "telegram-default", chatId: "native" }).length === 1, "重放相同事件不重复落库");
      await db.writeGatewayMessage({ ...nativeMessage, text: "同一时刻另一条" });
      assert(db.listGatewayMessages({ channelId: "telegram-default", chatId: "native" }).length === 2, "同一时刻不同文本仍然追加");
    } finally {
      db.connection.pragma("query_only = OFF");
    }
  }

  // 容量控制：>3000 条裁剪到 3000
  const now = Date.now();
  for (let i = 0; i < 3010; i++) {
    db.insertGatewayMessage({
      channelId: "telegram-default",
      chatId: "bulk",
      direction: "in",
      text: `msg-${i}`,
      at: now + i,
    });
  }
  const bulk = db.listGatewayMessages({ channelId: "telegram-default", chatId: "bulk", limit: 1000 });
  assert(bulk.length === 1000, `查询 limit 上限 1000（实际 ${bulk.length}）`);
  // 容量控制：库内只保留最近 3000 条（直连 SQL 数行，绕开 list 的 limit 上限）
  const raw = new Database(dbPath);
  const row = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM gateway_messages WHERE channel_id = 'telegram-default' AND chat_id = 'bulk'`,
    )
    .get() as { c: number };
  const first = raw
    .prepare(
      `SELECT text FROM gateway_messages WHERE channel_id = 'telegram-default' AND chat_id = 'bulk' ORDER BY created_at, id LIMIT 1`,
    )
    .get() as { text: string };
  raw.close();
  assert(row.c === 3000, `容量裁剪到 3000（实际 ${row.c}）`);
  assert(first.text === "msg-10", `裁剪保留最新（库内最早为 msg-10，实际 ${first.text}）`);
  // list 语义：limit 截断时取最近 N 条、按时间升序返回（聊天历史习惯）
  assert(bulk[0].text === "msg-2010", `list 返回最近 1000 条升序（实际 ${bulk[0].text}）`);

  await db.runtimeAuditReader?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

async function gatewayMessageWriteTest(): Promise<void> {
  console.log("== 消息写入：Rust 优先 / needsHost 回退 / 未知结果拒绝 ==");
  const dir = mkdtempSync(join(tmpdir(), "gw-write-"));
  const db = new AppDatabase(join(dir, "write.db"));
  const withWriter = (appendGatewayMessage: (message: unknown) => Promise<unknown>): void => {
    Object.assign(db, { runtimeAuditReader: { appendGatewayMessage, close: async () => undefined } });
  };
  const row = (chatId: string) => db.listGatewayMessages({ channelId: "telegram-default", chatId });
  try {
    // The writer owns the row: the host copy must stay empty, otherwise a replay doubles it.
    let calls = 0;
    withWriter(async () => { calls++; return { status: "saved" }; });
    await db.writeGatewayMessage({ channelId: "telegram-default", chatId: "saved", direction: "in", text: "worker", at: 1000 });
    assert(calls === 1 && row("saved").length === 0, "worker 回 saved 时宿主不再重复写入");

    // An unknown outcome is not permission to write the host copy.
    withWriter(async () => undefined);
    let rejected = "";
    await db.writeGatewayMessage({ channelId: "telegram-default", chatId: "unknown", direction: "in", text: "未知", at: 2000 })
      .catch(error => { rejected = String((error as Error)?.message ?? error); });
    assert(rejected.includes("未收到消息保存确认"), `结果未知时报错，实际：${rejected}`);
    assert(row("unknown").length === 0, "结果未知时宿主表没有写入");

    // An explicit needsHost is the only path that writes through the host primitive.
    calls = 0;
    withWriter(async () => { calls++; return { status: "needsHost" }; });
    await db.writeGatewayMessage({
      channelId: "telegram-default", chatId: "fallback", direction: "in", senderName: "alice", text: "宿主", at: 3000,
    });
    const fallback = row("fallback");
    assert(calls === 1 && fallback.length === 1 && fallback[0].text === "宿主" && fallback[0].senderName === "alice",
      "writer 明确 needsHost 时由宿主原语落库");

    // Inside a host transaction the worker is skipped, so the row joins that transaction.
    calls = 0;
    withWriter(async () => { calls++; return { status: "saved" }; });
    db.transaction(() => {
      void db.writeGatewayMessage({ channelId: "telegram-default", chatId: "transaction", direction: "in", text: "事务内", at: 4000 });
    });
    assert(calls === 0 && row("transaction").length === 1, "宿主事务内跳过 worker，直接随事务落库");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function telegramTextTest(): void {
  console.log("== Telegram：mdToHtml / 切分 ==");
  assert(
    mdToHtml("**加粗** 和 `code` 和 [链接](https://example.com?a=1&b=2)") ===
      "<b>加粗</b> 和 <code>code</code> 和 <a href=\"https://example.com?a=1&amp;b=2\">链接</a>",
    "加粗/行内代码/链接/& 转义",
  );
  assert(
    mdToHtml("```ts\nconst a = 1 < 2;\n```") ===
      "<pre><code>const a = 1 &lt; 2;</code></pre>",
    "代码块转义 < >",
  );
  assert(mdToHtml("普通文本 <script>") === "普通文本 &lt;script&gt;", "普通文本特殊字符转义");

  // 换行在 4096 中段（>50%）：优先在换行处断开
  const long = "x".repeat(3000) + "\n" + "y".repeat(4000);
  const chunks = splitTelegramText(long);
  assert(chunks.length === 2 && chunks[0].length === 3000, "超长文本在换行处断开");
  assert(chunks[1].length === 4000, "第二段完整");
  assert(splitTelegramText("short")[0] === "short", "短文本不切分");
}

function idempotencyTest(): void {
  console.log("== 幂等去重守卫 ==");
  const guard = createIdempotencyGuard(10_000);
  assert(guard("tg", "123", "m1") === true, "首次消息放行");
  assert(guard("tg", "123", "m1") === false, "同键重复拒绝（webhook 重试）");
  assert(guard("tg", "123", "m2") === true, "不同消息放行");
  assert(guard("tg", "456", "m1") === true, "不同 chat 同 messageId 放行");

  assert(guard("a:b", "c", "d") === true, "tuple first key");
  assert(guard("a", "b:c", "d") === true, "delimiter collision stays independent");
  guard.forget("a:b", "c", "d");
  assert(guard("a", "b:c", "d") === false, "forget cannot erase a neighboring tuple");
  const account = "a".repeat(64);
  const first = gatewayInboundIdentity("feishu-default", account, "chat", "msg");
  assert(JSON.stringify(first) === JSON.stringify(gatewayInboundIdentity("feishu-default", account, "chat", "msg")), "stable native identity");
  const other = gatewayInboundIdentity("feishu-default", "b".repeat(64), "chat", "msg");
  assert(first.taskId !== other.taskId && first.turnId !== other.turnId, "account scopes sessions and receipts");
  assert(gatewayInboundIdentity("a-b", account, "c", "d").taskId !== gatewayInboundIdentity("a", account, "b-c", "d").taskId, "task delimiter collision prevented");
  assert(gatewayInboundIdentity("a", account, "b:c", "d").turnId !== gatewayInboundIdentity("a", account, "b", "c:d").turnId, "turn delimiter collision prevented");
  assert(gatewayInboundIdentity("a", account, "b").turnId !== gatewayInboundIdentity("a", account, "b").turnId, "missing provider id never dedupes unrelated messages");
  let rejected = false;
  try { gatewayInboundIdentity("a", "", "b", "d"); } catch { rejected = true; }
  assert(rejected, "missing account fails closed");

  const shortGuard = createIdempotencyGuard(1, 100);
  assert(shortGuard("a", "b", "c") === true, "短窗口首条放行");
  const before = Date.now();
  // 等待窗口过期（10ms 内）
  void before;
  const expired = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(shortGuard("a", "b", "c")), 5);
  });
  expired.then((ok) => assert(ok, "窗口过期后同键重新放行"));
}

function allowlistTest(): void {
  console.log("== 白名单判断 ==");
  assert(isAllowedUser([], undefined) === true, "空白名单不限制");
  assert(isAllowedUser(["u1", "u2"], "u1") === true, "命中白名单放行");
  assert(isAllowedUser(["u1"], "u3") === false, "未命中拒绝");
  assert(isAllowedUser(["u1"], undefined) === false, "无发送者信息拒绝");
}

async function telegramE2eTest(): Promise<void> {
  console.log("== Telegram 适配器 E2E（本地 mock API）==");
  const received: Array<{
    chatId: string;
    text: string;
    messageId?: string;
    sender?: { id: string; name?: string };
  }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const captured: { reply?: (text: string) => Promise<void> } = {};
  let updatesLeft = 1;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/getMe")) {
      res.end(JSON.stringify({ ok: true, result: { username: "mock_bot" } }));
      return;
    }
    if (url.pathname.endsWith("/getUpdates")) {
      if (updatesLeft > 0) {
        updatesLeft--;
        res.end(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 1,
                message: {
                  message_id: 101,
                  chat: { id: 42, type: "private" },
                  text: "hello **world**",
                  from: { id: 7, username: "alice" },
                },
              },
            ],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true, result: [] }));
      return;
    }
    if (url.pathname.endsWith("/sendMessage")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      sent.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.end(JSON.stringify({ ok: false, description: `unexpected ${url.pathname}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}/bot`;

  const adapter = new TelegramChannelAdapter("telegram-default", "Telegram", base);
  const gotInbound = new Promise<void>((resolve) => {
    adapter.setInboundHandler((msg) => {
      received.push({
        chatId: msg.chatId,
        text: msg.text,
        messageId: msg.messageId,
        sender: msg.sender,
      });
      captured.reply = msg.reply;
      resolve();
      return Promise.resolve();
    });
  });

  await adapter.connect({ botToken: "TOKEN" });
  assert(adapter.isConnected(), "connect 后 isConnected");
  assert(adapter.statusText().includes("mock_bot"), `statusText 显示 bot 用户名（${adapter.statusText()}）`);

  await gotInbound;
  assert(received.length === 1, "轮询收到 1 条消息");
  assert(received[0].chatId === "42" && received[0].text === "hello **world**", "chatId/文本解析正确");
  assert(received[0].messageId === "101", "messageId 透传（幂等键）");
  assert(received[0].sender?.id === "7" && received[0].sender?.name === "alice", "sender 透传（白名单用）");

  // reply → sendMessage：markdown 转 HTML + parse_mode
  await captured.reply?.("**ok** `code`");
  await new Promise((r) => setTimeout(r, 100));
  assert(sent.length === 1, "sendMessage 被调用");
  assert(sent[0].chat_id === 42 && sent[0].text === "<b>ok</b> <code>code</code>", "markdown→HTML 转换正确");
  assert(sent[0].parse_mode === "HTML", "parse_mode=HTML");

  await adapter.disconnect();
  assert(!adapter.isConnected(), "disconnect 后 isConnected false");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  await dbTest();
  await gatewayMessageWriteTest();
  telegramTextTest();
  idempotencyTest();
  // 等待异步过期断言完成
  setTimeout(() => {
    allowlistTest();
    telegramE2eTest().then(() => {
      console.log(`\n结果：${passed} 通过，${failed} 失败`);
      if (failed > 0) process.exit(1);
    });
  }, 30);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
