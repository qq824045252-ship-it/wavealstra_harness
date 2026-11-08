import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackSocketModeAdapter, type SlackSocket } from "../src/main/gateway/SlackSocketModeAdapter";
import { SlackGatewayJournal, type SlackDelivery } from "../src/main/gateway/SlackGatewayJournal";
const root = mkdtempSync(join(tmpdir(), "slack-media-"));
const config = { teamId: "T123", appId: "A123", allowUsers: ["U123"], botToken: "xoxb-fixture", appToken: "xapp-fixture" };
class Socket implements SlackSocket {
  onmessage: SlackSocket["onmessage"] = null; onclose: SlackSocket["onclose"] = null; onerror: SlackSocket["onerror"] = null;
  ack = 0;
  send(): void { this.ack++; }
  close(): void { this.onclose?.(); }
  emit(event: unknown): void { this.onmessage?.({ data: JSON.stringify(event) }); }
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("Timeout");
}
let serial = 0;
async function fixture(options: { recovery?: SlackDelivery; url?: string; size?: number; infoError?: boolean; afterInfo?: () => Promise<void>; afterDownload?: () => Promise<void> } = {}) {
  const socket = new Socket(); const path = join(root, String(++serial) + ".json");
  const journal = new SlackGatewayJournal(() => path);
  if (options.recovery) journal.accept(options.recovery);
  const state = { info: 0, downloads: 0, inputs: [] as any[], posts: [] as any[] };
  const adapter = new SlackSocketModeAdapter("slack", "Slack", { journal, mediaDirectory: join(root, "media"),
    socketFactory: () => { setTimeout(() => socket.emit({ type: "hello", connection_info: { app_id: config.appId } }), 0); return socket; },
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.redirect, "error");
      if (url.hostname === "files.slack.com") {
        state.downloads++; assert.ok(socket.ack); assert.equal(init?.headers && (init.headers as any).Authorization, "Bearer " + config.botToken);
        await options.afterDownload?.(); return new Response("fixture bytes");
      }
      assert.equal(url.hostname, "slack.com");
      const method = url.pathname.split("/").at(-1);
      let result: unknown;
      if (method === "auth.test") result = { ok: true, bot_id: "B123", user_id: "UBOT", team_id: config.teamId };
      else if (method === "apps.connections.open") result = { ok: true, url: "wss://wss.slack.com/link" };
      else if (method === "files.info") {
        state.info++; assert.ok(socket.ack); assert.equal(journal.list().length, 1); assert.equal(url.searchParams.get("file"), "F123");
        await options.afterInfo?.(); result = options.infoError ? { ok: false, error: "missing_scope" } : { ok: true, file: { id: "F123", name: "test.txt", size: options.size ?? 13, url_private: options.url ?? "https://files.slack.com/files/test" } };
      } else if (method === "chat.postMessage") { state.posts.push(JSON.parse(String(init?.body))); result = { ok: true }; }
      else throw new Error("Unexpected API " + method);
      return new Response(JSON.stringify(result));
    }) as typeof fetch,
  });
  adapter.setInboundHandler(async input => { state.inputs.push(input); await input.reply("done"); });
  await adapter.connect(config);
  const emit = (overrides = {}) => socket.emit({ type: "events_api", envelope_id: "env", payload: {
    type: "event_callback", api_app_id: config.appId, team_id: config.teamId, event_id: "E123",
    event: { type: "message", subtype: "file_share", channel_type: "im", channel: "D123", user: "U123", ts: "123.456", text: "", files: [{ id: "F123", url_private: "https://evil.test/ignored", token: config.botToken }], ...overrides },
  } });
  return { adapter, state, emit, journal, path };
}
try {
  const f = await fixture(); f.emit(); await until(() => f.journal.list()[0]?.state === "replied");
  assert.equal(f.state.inputs.length, 1); assert.equal(readFileSync(f.state.inputs[0].attachments[0].path, "utf8"), "fixture bytes");
  const saved = readFileSync(f.path, "utf8"); assert.ok(!saved.includes(config.botToken)); assert.ok(!saved.includes("evil.test"));
  f.emit(); await new Promise(r => setTimeout(r, 10)); assert.equal(f.state.downloads, 1);
  assert.equal(new SlackGatewayJournal(() => f.path).list()[0].attachments?.length, 1);
  await f.adapter.disconnect();
  const recovered = await fixture({ recovery: { ...f.journal.list()[0], state: "running" } });
  await until(() => recovered.journal.list()[0]?.state === "replied");
  assert.equal(recovered.state.info, 0); assert.equal(recovered.state.downloads, 0);
  assert.deepEqual(recovered.state.inputs[0].attachments, f.state.inputs[0].attachments);
  await recovered.adapter.disconnect();
  const { files: _files, attachments: _attachments, ...legacy } = f.journal.list()[0];
  const old = await fixture({ recovery: { ...legacy, state: "pending", text: "legacy text" } });
  await until(() => old.journal.list()[0]?.state === "replied");
  assert.equal(old.state.inputs.length, 1); assert.equal(old.state.info, 0); await old.adapter.disconnect();
  for (const attachments of [undefined, []]) {
    const broken = await fixture({ recovery: { ...f.journal.list()[0], state: "running", attachments } });
    await until(() => broken.journal.list()[0]?.state === "replied");
    assert.equal(broken.state.inputs.length, 0); assert.equal(broken.state.info, 0); assert.equal(broken.state.downloads, 0);
    assert.match(broken.state.posts[0].text, /缓存丢失或校验失败/); await broken.adapter.disconnect();
  }
  const cachedPath = f.state.inputs[0].attachments[0].path;
  const originalBytes = readFileSync(cachedPath);
  for (const damage of ["missing", "corrupt", "symlink", "oversize"] as const) {
    unlinkSync(cachedPath);
    if (damage === "corrupt") writeFileSync(cachedPath, "altered bytes");
    if (damage === "symlink") {
      const target = join(root, "linked-bytes"); writeFileSync(target, originalBytes); symlinkSync(target, cachedPath);
    }
    if (damage === "oversize") writeFileSync(cachedPath, Buffer.alloc(21 * 1024 * 1024));
    const broken = await fixture({ recovery: { ...f.journal.list()[0], state: "running" } });
    await until(() => broken.journal.list()[0]?.state === "replied");
    assert.equal(broken.state.inputs.length, 0, damage + " must not enter native task");
    assert.equal(broken.state.info, 0); assert.equal(broken.state.downloads, 0);
    assert.match(broken.state.posts[0].text, /缓存丢失或校验失败/);
    assert.deepEqual(broken.journal.list()[0].attachments, f.journal.list()[0].attachments);
    await broken.adapter.disconnect();
    if (damage !== "missing") unlinkSync(cachedPath);
    writeFileSync(cachedPath, originalBytes);
  }
  for (const options of [{ url: "https://evil.test/file" }, { url: "http://files.slack.com/file" }, { url: "https://files.slack.com.evil.test/file" }, { url: "https://user:pass@files.slack.com/file" }, { size: 21 * 1024 * 1024 }, { infoError: true }]) {
    const f = await fixture(options); f.emit(); await until(() => f.journal.list()[0]?.state === "replied");
    assert.equal(f.state.inputs.length, 0); assert.equal(f.state.downloads, 0); assert.match(f.state.posts[0].text, /失败/); await f.adapter.disconnect();
  }
  for (const overrides of [{ user: "UOTHER" }, { type: "message", channel_type: "channel", channel: "C123" }, { type: "app_mention", channel: "C123", text: "not mentioned" }]) {
    const f = await fixture(); f.emit(overrides); await new Promise(r => setTimeout(r, 10)); assert.equal(f.state.info, 0); assert.equal(f.journal.list().length, 0); await f.adapter.disconnect();
  }
  for (const stage of ["afterInfo", "afterDownload"] as const) {
    let release!: () => void; let reached = false;
    const gate = new Promise<void>(r => { release = r; });
    const f = await fixture({ [stage]: async () => { reached = true; await gate; } });
    f.emit(); await until(() => reached); await f.adapter.disconnect(); release(); await new Promise(r => setTimeout(r, 30));
    assert.equal(f.state.inputs.length, 0); assert.equal(f.state.posts.length, 0); assert.equal(f.journal.list()[0].state, "pending");
    if (stage === "afterInfo") assert.equal(f.state.downloads, 0);
  }
  console.log("PASS Slack secure media ingress, journal dedupe/cache, authorization, failure and stale generation checks");
} finally { rmSync(root, { recursive: true, force: true }); }
