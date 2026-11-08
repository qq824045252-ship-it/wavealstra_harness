import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramChannelAdapter, type GatewayInboundMessage } from "../src/main/gateway/channels";

const home = mkdtempSync(join(tmpdir(), "telegram-media-test-"));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const originalFetch = globalThis.fetch;
const token = "123:fixture-secret";
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  await run(); console.log("PASS " + name); passed++;
}
function fixture() {
  const adapter = new TelegramChannelAdapter("tg", "Telegram", "https://test.invalid/bot");
  const internal = adapter as unknown as {
    connected: boolean; generation: number; stopped: boolean; polling: boolean; offset: number;
    config: { botToken: string; allowUsers?: string[] }; botId: string; lastError: string;
    handleUpdate(update: unknown): Promise<void>; pollLoop(generation: number): Promise<void>;
  };
  Object.assign(internal, { connected: true, generation: 1, stopped: false, polling: true, offset: 0, config: { botToken: token }, botId: "123" });
  return { adapter, internal };
}
const message = (extra: Record<string, unknown> = {}) => ({ update_id: 10, message: {
  message_id: 9, chat: { id: -100, type: "supergroup" }, from: { id: 7 }, ...extra,
} });

try {
  await check("allowUsers rejects media before any credentialed fetch", async () => {
    const { adapter, internal } = fixture(); internal.config.allowUsers = ["8"];
    let downloads = 0, inbound = 0;
    globalThis.fetch = async () => { downloads++; throw new Error("must not fetch"); };
    adapter.setInboundHandler(async () => { inbound++; });
    await internal.handleUpdate(message({ photo: [{ file_id: "blocked" }] }));
    await internal.handleUpdate(message({ from: undefined, document: { file_id: "blocked" } }));
    assert.equal(downloads, 0); assert.equal(inbound, 0); await adapter.disconnect();
  });
  await check("permanently rejected media does not block the next update", async () => {
    const { adapter, internal } = fixture(); const seen: string[] = [];
    globalThis.fetch = async () => json({ ok: true, result: [
      { ...message({ photo: [{ file_id: "oversize", file_size: 21 * 1024 * 1024 }] }), update_id: 10 },
      { ...message({ text: "next" }), update_id: 11 },
    ] });
    adapter.setInboundHandler(async msg => { seen.push(msg.text); internal.polling = false; });
    await internal.pollLoop(1);
    assert.deepEqual(seen, ["next"]); assert.equal(internal.offset, 12);
    assert.match(internal.lastError, /已拒绝/); assert.match(adapter.statusText(), /已拒绝/); await adapter.disconnect();
  });
  await check("five Telegram media kinds retain captions and reply/topic address", async () => {
    const { adapter, internal } = fixture();
    const seen: GatewayInboundMessage[] = [];
    const fileIds: string[] = [];
    const replies: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/getFile")) {
        assert.equal(url, `https://api.telegram.org/bot${token}/getFile`);
        assert.equal(init?.redirect, "error");
        fileIds.push(JSON.parse(String(init?.body)).file_id);
        return json({ ok: true, result: { file_path: "files/test.bin", file_size: 5 } });
      }
      if (url.includes("/file/bot")) { assert.equal(init?.redirect, "error"); return new Response("media"); }
      if (url.endsWith("/sendMessage")) { replies.push(JSON.parse(String(init?.body))); return json({ ok: true }); }
      throw new Error("unexpected request");
    };
    adapter.setInboundHandler(async msg => {
      seen.push(msg);
      assert.equal(readFileSync(msg.attachments![0].path, "utf8"), "media");
      await msg.reply("reply");
    });
    for (const kind of ["photo", "document", "video", "audio", "voice"]) {
      const media = { file_id: kind, file_name: kind === "document" ? "../../report.pdf" : undefined };
      await internal.handleUpdate(message({ [kind]: kind === "photo" ? [{ file_id: "thumbnail" }, media] : media,
        caption: " caption ", message_thread_id: 77, direct_messages_topic: { topic_id: 88 } }));
    }
    assert.deepEqual(fileIds, ["photo", "document", "video", "audio", "voice"]);
    assert.equal(seen.length, 5);
    assert.ok(seen.every(msg => msg.text === "caption" && msg.workTarget?.channelType === "telegram" && msg.workTarget.address.messageThreadId === 77));
    assert.ok(seen.every(msg => !msg.attachments![0].name.includes("/")));
    assert.ok(replies.every(reply => reply.reply_to_message_id === 9 && reply.message_thread_id === 77 && reply.direct_messages_topic_id === 88));
    assert.equal(readFileSync(seen[0].attachments![0].path, "utf8"), "media", "cache survives admission for later native task turns");
    await adapter.disconnect();
  });
  await check("media-only update is admitted without inventing a caption", async () => {
    const { adapter, internal } = fixture();
    let inbound = 0;
    globalThis.fetch = async input => String(input).endsWith("/getFile")
      ? json({ ok: true, result: { file_path: "voice/file.ogg" } }) : new Response("voice");
    adapter.setInboundHandler(async msg => { inbound++; assert.equal(msg.text, ""); assert.equal(msg.attachments?.length, 1); });
    await internal.handleUpdate(message({ voice: { file_id: "voice" } }));
    assert.equal(inbound, 1); await adapter.disconnect();
  });
  await check("unsafe file paths and oversize metadata cannot trigger a download", async () => {
    const { adapter, internal } = fixture();
    let downloads = 0;
    adapter.setInboundHandler(async () => { throw new Error("must not admit"); });
    for (const path of ["../secret", "files/../secret", "https://evil.invalid/x", "/tmp/local", "files/%2e%2e", "files/a?token=x", "files/a\\b"]) {
      globalThis.fetch = async input => {
        if (!String(input).endsWith("/getFile")) { downloads++; throw new Error("forbidden"); }
        return json({ ok: true, result: { file_path: path } });
      };
      await assert.rejects(internal.handleUpdate(message({ document: { file_id: "bad" } })), /路径无效/);
    }
    globalThis.fetch = async () => { downloads++; throw new Error("must reject before request"); };
    await assert.rejects(internal.handleUpdate(message({ document: { file_id: "big", file_size: 20 * 1024 * 1024 + 1 } })), /大小无效/);
    assert.equal(downloads, 0); await adapter.disconnect();
  });
  await check("account generation changes during metadata or download prevent admission", async () => {
    for (const disconnectAt of ["metadata", "download"]) {
      const { adapter, internal } = fixture();
      let admitted = 0; let downloads = 0;
      adapter.setInboundHandler(async () => { admitted++; });
      globalThis.fetch = async input => {
        if (String(input).endsWith("/getFile")) {
          if (disconnectAt === "metadata") await adapter.disconnect();
          return json({ ok: true, result: { file_path: "files/file.bin" } });
        }
        downloads++;
        await adapter.disconnect();
        return new Response("stale");
      };
      await assert.rejects(internal.handleUpdate(message({ document: { file_id: "stale" } })));
      assert.equal(admitted, 0); assert.equal(downloads, disconnectAt === "metadata" ? 0 : 1);
    }
  });
  await check("media errors never reveal a token-bearing URL", async () => {
    const { adapter, internal } = fixture();
    adapter.setInboundHandler(async () => {});
    for (const metadataFailure of [true, false]) {
      globalThis.fetch = async input => {
        if (!metadataFailure && String(input).endsWith("/getFile")) return json({ ok: true, result: { file_path: "files/file.bin" } });
        throw new Error(String(input));
      };
      await assert.rejects(internal.handleUpdate(message({ document: { file_id: "bad" } })), error => !String(error).includes(token));
    }
    await adapter.disconnect();
  });
  await check("failed update is retried before any later update or offset acknowledgement", async () => {
    const { adapter, internal } = fixture();
    const offsets: string[] = []; const attempts: string[] = [];
    let first = true;
    globalThis.fetch = async input => {
      offsets.push(new URL(String(input)).searchParams.get("offset")!);
      if (offsets.length === 3) { await adapter.disconnect(); return json({ ok: true, result: [] }); }
      return json({ ok: true, result: [message({ text: "first" }), { ...message({ text: "second", message_id: 11 }), update_id: 11 }] });
    };
    adapter.setInboundHandler(async msg => {
      attempts.push(msg.text);
      if (first) { first = false; throw new Error(`fetch failed ${token}`); }
    });
    await internal.pollLoop(1);
    assert.deepEqual(attempts, ["first", "first", "second"]);
    assert.deepEqual(offsets, ["0", "0", "12"]);
    assert.ok(!internal.lastError.includes(token));
  });
  console.log(`Telegram media: ${passed} checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  rmSync(home, { recursive: true, force: true });
}
