/**
 * Gateway 冒烟测试：DB 迁移/消息落库/容量控制、Telegram md→HTML、消息切分、
 * 幂等去重守卫、白名单判断。
 * 运行：pnpm test:gateway（esbuild bundle + node 直跑，不依赖 electron）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AppDatabase } from "../src/main/db/AppDatabase";
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

function dbTest(): void {
  console.log("== DB：gateway_messages 迁移/落库/查询 ==");
  const dir = mkdtempSync(join(tmpdir(), "gw-test-"));
  const dbPath = join(dir, "test.db");
  const db = new AppDatabase(dbPath);

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
  const raw = new (require("better-sqlite3") as typeof import("better-sqlite3").default)(dbPath);
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

  db.close();
  rmSync(dir, { recursive: true, force: true });
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
  let replyFn: ((text: string) => Promise<void>) | null = null;
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
      replyFn = msg.reply;
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
  await replyFn?.("**ok** `code`");
  await new Promise((r) => setTimeout(r, 100));
  assert(sent.length === 1, "sendMessage 被调用");
  assert(sent[0].chat_id === 42 && sent[0].text === "<b>ok</b> <code>code</code>", "markdown→HTML 转换正确");
  assert(sent[0].parse_mode === "HTML", "parse_mode=HTML");

  await adapter.disconnect();
  assert(!adapter.isConnected(), "disconnect 后 isConnected false");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function main(): void {
  dbTest();
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

main();
