import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DingTalkStreamAdapter, type DingTalkSocket } from "../src/main/gateway/DingTalkStreamAdapter";
import type { GatewayInboundMessage } from "../src/main/gateway/channels";
class Socket implements DingTalkSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: number[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw).code); }
  close() {}
}
const home = await mkdtemp(join(tmpdir(), "dingtalk-media-"));
const originalHome = process.env.HOME;
process.env.HOME = home;
const socket = new Socket();
let target = "https://static.dingtalk.com/media/test.png";
let downloads = 0;
let stage = "";
let releaseDownload: (() => void) | undefined;
const messages: GatewayInboundMessage[] = [];
const adapter = new DingTalkStreamAdapter("ding", "DingTalk", {
  socketFactory: () => { queueMicrotask(() => socket.onopen?.()); return socket; },
  fetch: async (url, init) => {
    assert.equal(init?.redirect, "error");
    const address = String(url);
    if (address.includes("connections/open")) return Response.json({ endpoint: "wss://stream.dingtalk.com/open", ticket: "ticket" });
    if (address.includes("oauth2")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { appKey: "app", appSecret: "secret" });
      if (stage === "auth") await adapter.disconnect();
      if (stage === "auth-transient") return new Response(null, { status: 503 });
      return Response.json({ accessToken: "token" });
    }
    if (address.includes("messageFiles")) {
      assert.equal((init?.headers as Record<string, string>)["x-acs-dingtalk-access-token"], "token");
      assert.equal(JSON.parse(String(init?.body)).robotCode, "robot");
      if (stage === "resolve") await adapter.disconnect();
      if (stage === "resolve-transient") throw new Error("temporary network error");
      return Response.json({ downloadUrl: target });
    }
    downloads++;
    if (stage === "download-transient") return new Response(null, { status: 503 });
    if (stage === "download-pending") await new Promise<void>(resolve => { releaseDownload = resolve; });
    assert.equal(init?.headers, undefined, "access token never goes to CDN");
    if (stage === "download") await adapter.disconnect();
    if (stage === "oversize") return new Response("x", { headers: { "content-length": String(21 * 1024 * 1024) } });
    if (stage === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.test" } });
    return new Response("image bytes");
  },
});
const config = { clientId: "app", clientSecret: "secret", corpId: "corp", robotCode: "robot", allowUsers: ["staff"] };
adapter.setInboundHandler(async message => { messages.push(message); });
let id = 0;
const internal = adapter as unknown as { generation: number; receive(raw: string, generation: number, socket: DingTalkSocket): Promise<void> };
const receive = (msgtype: string, content: unknown, extra: Record<string, unknown> = {}) => internal.receive(JSON.stringify({
  type: "CALLBACK", headers: { messageId: String(++id), topic: "/v1.0/im/bot/messages/get" },
  data: JSON.stringify({ chatbotCorpId: "corp", senderCorpId: "corp", robotCode: "robot", senderStaffId: "staff",
    conversationId: "room", conversationType: "1", msgId: String(id), msgtype, content,
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=secret", sessionWebhookExpiredTime: Date.now() + 60_000, ...extra }),
}), internal.generation, socket);
try {
  await adapter.connect(config);
  await receive("picture", { downloadCode: "image-code" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].attachments?.length, 1);
  assert.equal(await readFile(messages[0].attachments![0].path, "utf8"), "image bytes");
  await receive("file", { downloadCode: "file-code", fileName: "report.pdf" });
  assert.equal(messages[1].attachments![0].name, "report.pdf");
  await receive("richText", { richText: [{ text: "review @literal" }, { type: "picture", pictureDownloadCode: "picture-code" }, { type: "file", downloadCode: "file-code", fileName: "a.txt" }] });
  assert.equal(messages[2].text, "review @literal");
  assert.equal(messages[2].attachments?.length, 2);
  await receive("audio", { recognition: "recognized", downloadCode: "voice-code" });
  assert.equal(messages[3].text, "recognized");
  await receive("audio", { downloadCode: "voice-code" });
  assert.equal(messages[4].attachments?.length, 1);
  const before = downloads;
  await receive("picture", { downloadCode: "forbidden" }, { senderStaffId: "outsider" });
  assert.equal(downloads, before);
  for (const url of ["http://static.dingtalk.com/a", "https://evil.test/a", "https://static.dingtalk.com.evil.test/a", "https://localhost/a", "https://static.dingtalk.com:444/a"]) {
    target = url;
    await assert.rejects(receive("picture", { downloadCode: "code" }));
    assert.equal(downloads, before);
  }
  target = "https://static.dingtalk.com/media/test.png";
  for (stage of ["oversize", "redirect"]) await assert.rejects(receive("picture", { downloadCode: "code" }));
  for (stage of ["auth-transient", "resolve-transient", "download-transient"]) {
    const event = { msgId: stage };
    const count = messages.length;
    const acks = socket.sent.length;
    await assert.rejects(receive("picture", { downloadCode: "retry-code" }, event));
    assert.deepEqual(socket.sent.slice(acks), [503], "no success ACK before admission");
    assert.equal(messages.length, count);
    stage = "";
    await receive("picture", { downloadCode: "retry-code" }, event);
    assert.equal(messages.length, count + 1, "same event succeeds after temporary failure");
    await receive("picture", { downloadCode: "retry-code" }, event);
    assert.equal(messages.length, count + 1, "admitted event never replays");
  }
  stage = "download-pending";
  const pendingAcks = socket.sent.length;
  const pendingCount = messages.length;
  const pending = receive("picture", { downloadCode: "pending-code" }, { msgId: "pending" });
  while (!releaseDownload) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(socket.sent.length, pendingAcks, "download in progress is not ACKed as success");
  await receive("picture", { downloadCode: "pending-code" }, { msgId: "pending" });
  assert.equal(socket.sent.at(-1), 503, "concurrent duplicate is not lost or admitted twice");
  stage = "";
  releaseDownload();
  await pending;
  assert.equal(messages.length, pendingCount + 1);
  assert.equal(socket.sent.at(-1), 200);
  stage = "oversize";
  await assert.rejects(receive("picture", { downloadCode: "too-large" }, { msgId: "permanent" }));
  assert.equal(socket.sent.at(-1), 200, "permanent rejection is terminal");
  assert.match(adapter.statusText(), /附件被拒绝/);
  const permanentDownloads = downloads;
  await receive("picture", { downloadCode: "too-large" }, { msgId: "permanent" });
  assert.equal(downloads, permanentDownloads);
  stage = "";
  let agentCalls = 0;
  adapter.setInboundHandler(async () => { agentCalls++; throw new Error("agent side effect already started"); });
  await assert.rejects(receive("picture", { downloadCode: "code" }, { msgId: "agent-failure" }));
  await receive("picture", { downloadCode: "code" }, { msgId: "agent-failure" });
  assert.equal(agentCalls, 1);
  adapter.setInboundHandler(async message => { messages.push(message); });
  const admittedCount = messages.length;
  for (stage of ["auth", "resolve", "download"]) {
    await adapter.connect(config);
    await assert.rejects(receive("picture", { downloadCode: "code" }));
  }
  assert.equal(messages.length, admittedCount, "stale generations never enter agent");
  console.log("PASS DingTalk media: official codes, pure media, rich text, recognition, authorization, host fence, size, redirects and stale generations");
} finally {
  await adapter.disconnect();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
}
