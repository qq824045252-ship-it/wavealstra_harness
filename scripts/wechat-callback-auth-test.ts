import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WechatMpChannelAdapter } from "../src/main/gateway/channels";
import { WxCrypt } from "../src/main/gateway/wx-crypt";
const token = "fixture-token", timestamp = "123", nonce = "nonce";
const adapter = new WechatMpChannelAdapter("wechat", "WeChat MP");
const crypt = new WxCrypt(token, Buffer.alloc(32, 1).toString("base64").replace(/=$/, ""), "app");
Object.assign(adapter, { connected: true, config: { token, appId: "app" }, crypt });
let calls = 0;
adapter.setInboundHandler(async () => { calls++; });
const rawBody = "<xml><MsgType>text</MsgType><FromUserName>owner</FromUserName><Content>hello</Content><MsgId>1</MsgId></xml>";
for (const query of [new URLSearchParams(), new URLSearchParams({ timestamp, nonce, signature: "0".repeat(40) }), new URLSearchParams({ timestamp, nonce, msg_signature: "0".repeat(40) })]) {
  assert.equal((await adapter.handleHttp({ method: "POST", query, rawBody })).status, 403);
}
assert.equal(calls, 0);
const signature = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
assert.equal((await adapter.handleHttp({ method: "POST", query: new URLSearchParams({ timestamp, nonce, signature }), rawBody })).status, 200);
assert.equal(calls, 1);
await adapter.disconnect();
console.log("PASS WeChat MP plaintext compatibility requires a valid token signature before native admission");
