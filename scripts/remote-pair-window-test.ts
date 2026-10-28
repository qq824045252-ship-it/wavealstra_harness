/**
 * 域名直连准入闸门：默认关闭 + 一次性 6 位配对码 + 失败即作废。
 * 这里不依赖 Electron，直接起真实 RemoteAccessServer（其余依赖用 stub）。
 */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { RemoteAccessServer } from "../src/main/remote/RemoteAccessServer";
import { RemoteDeviceStore } from "../src/main/remote/RemoteDeviceStore";
import { RemotePairWindow } from "../src/main/remote/RemotePairWindow";

const devicesPath = join(tmpdir(), `pair-window-test-${Date.now()}.json`);
const devices = new RemoteDeviceStore(devicesPath);
const pairWindow = new RemotePairWindow();
const stub = new Proxy({}, { get: () => () => ({}) });
const server = new RemoteAccessServer({
  port: 0,
  devices,
  pairing: stub as never,
  pairWindow,
  service: stub as never,
  commands: stub as never,
  events: stub as never,
});

const { port } = await server.start();
const url = `http://127.0.0.1:${port}/v1/pair/direct`;
const post = (body: unknown) => fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const installationId = "inst-pair-window-test";

// 1) 窗口未开启：任何人都拿不到令牌
const closed = await post({ deviceName: "Android", installationId, code: "000000" });
assert.equal(closed.status, 403, "窗口未开启必须 403");
assert.equal(devices.list(false).length, 0, "被拒时不得写入设备");

// 2) 桌面端开启窗口，拿到 6 位码
const opened = pairWindow.open();
assert.match(opened.code, /^\d{6}$/, "配对码必须是 6 位数字");
assert.ok(opened.expiresAt > Date.now(), "窗口必须有未来到期时间");

// 3) 错码：拒绝
const wrong = await post({ deviceName: "Android", installationId, code: opened.code === "000000" ? "111111" : "000000" });
assert.equal(wrong.status, 403, "错误配对码必须 403");

// 4) 正确码：签发令牌
const ok = await post({ deviceName: "Android", installationId, code: opened.code });
assert.equal(ok.status, 200, "正确配对码应签发令牌");
const payload = await ok.json() as { deviceToken?: string };
assert.ok(payload.deviceToken && payload.deviceToken.length > 20, "必须返回设备令牌");
assert.equal(devices.list(false).length, 1, "应写入一台设备");

// 5) 码已被消费：同一个码不能再用
const reuse = await post({ deviceName: "Android", installationId: "inst-another", code: opened.code });
assert.equal(reuse.status, 403, "一次性配对码不得复用");
assert.equal(devices.list(false).length, 1, "复用不得新增设备");

// 6) 连续输错 5 次即作废窗口，之后即使填对也进不来
const second = pairWindow.open();
for (let i = 0; i < 5; i += 1) {
  const miss = await post({ deviceName: "Android", installationId: "inst-brute", code: second.code === "000000" ? "111111" : "000000" });
  assert.equal(miss.status, 403);
}
assert.equal(pairWindow.state(), null, "输错达到上限必须作废窗口");
const afterLockout = await post({ deviceName: "Android", installationId: "inst-brute", code: second.code });
assert.equal(afterLockout.status, 403, "作废后正确码也不再放行");

// 7) 到期即失效
const expiring = new RemotePairWindow(20);
const code = expiring.open().code;
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(expiring.state(), null, "窗口到期应自动失效");
assert.equal(expiring.consume(code), false, "过期窗口不得放行");

await server.stop();
rmSync(devicesPath, { force: true });
console.log("remote pair window tests passed");
