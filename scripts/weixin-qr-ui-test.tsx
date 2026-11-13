import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import WeixinGatewaySettings from "../src/renderer/src/components/settings/WeixinGatewaySettings";
import type { GatewayWeixinQrLoginStateDto } from "../src/shared/agent-ipc";

const { window: testWindow, document: testDocument } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: testWindow, document: testDocument, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const tick = async (ms = 20) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };
let resolveStart!: (value: GatewayWeixinQrLoginStateDto) => void;
let starts = 0, disconnects = 0, connected = false;
const cancelled: Array<string | undefined> = [];
let remote: GatewayWeixinQrLoginStateDto = { state: "idle", message: "idle" };
Object.assign(testWindow, { api: { gateway: {
  status: async () => ({ channels: [{ id: "weixin-default", connected }] }),
  weixinQrStart: async (approved: boolean) => { assert.equal(approved, true); starts++; return new Promise<GatewayWeixinQrLoginStateDto>(resolve => { resolveStart = resolve; }); },
  weixinQrState: async () => remote,
  weixinQrCancel: async (id?: string) => { cancelled.push(id); return { state: "cancelled", sessionId: id, message: "cancelled" }; },
  disconnect: async () => { disconnects++; connected = false; },
} } });
const host = testDocument.body.appendChild(testDocument.createElement("div"));
let root = createRoot(host);
const button = (text: string) => Array.from(testDocument.querySelectorAll("button")).find(value => value.textContent === text) as HTMLButtonElement;
const mount = async () => { await act(async () => { root.render(<WeixinGatewaySettings />); }); await tick(); await act(async () => button("配置").click()); };
const approve = async () => {
  const checkbox = testDocument.querySelector("input") as HTMLInputElement;
  await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
};
await mount();
assert.equal(starts, 0); assert(button("开始扫码授权").disabled);
await approve();
assert.equal(button("开始扫码授权").disabled, false);
await act(async () => { button("开始扫码授权").click(); button("开始扫码授权").click(); });
assert.equal(starts, 1);
await act(async () => root.unmount());
resolveStart({ state: "waiting", sessionId: "closed-start", qrUrl: "https://q.qq.com/test", message: "scan" });
await tick(); assert.deepEqual(cancelled, ["closed-start"]);

root = createRoot(host); await mount();
assert(button("开始扫码授权").disabled);
await approve(); await act(async () => button("开始扫码授权").click());
remote = { state: "waiting", sessionId: "live", qrUrl: "https://q.qq.com/test", message: "scan" };
await act(async () => resolveStart(remote)); await tick(100);
assert(testDocument.querySelector('img[alt="微信 官方授权二维码"]'));
await act(async () => button("取消扫码").click());
assert.equal(cancelled.at(-1), "live"); assert.equal(testDocument.querySelector("img"), null);
assert(button("开始扫码授权").disabled);

await approve(); await act(async () => button("开始扫码授权").click());
remote = { state: "waiting", sessionId: "complete", qrUrl: "https://q.qq.com/test", message: "scan" };
await act(async () => resolveStart(remote)); await tick();
connected = true; remote = { state: "connected", sessionId: "complete", message: "connected" };
await tick(1100);
assert.equal(testDocument.querySelector("img"), null);
assert.equal(button("管理").getAttribute("aria-expanded"), "false");
await act(async () => button("管理").click());
assert.equal(button("断开 微信").disabled, false);
assert.equal(button("开始扫码授权"), undefined);
await act(async () => button("断开 微信").click());
assert.equal(disconnects, 1);
// Terminal states from the same enrollment must keep their actual explanation.
for (const state of ["expired", "error"] as const) {
  const sessionId = `terminal-${state}`;
  const message = state === "expired" ? "二维码已过期，请重新授权" : "微信扫码授权失败，请重试";
  await approve();
  await act(async () => button("开始扫码授权").click());
  remote = { state: "waiting", sessionId, qrUrl: "https://example.test/weixin-qr", message: "scan" };
  await act(async () => resolveStart(remote));
  await tick(100);
  assert(testDocument.querySelector('img[alt="微信 官方授权二维码"]'));
  remote = { state, sessionId, message };
  await tick(1100);
  assert.equal(testDocument.querySelector('[role="status"]')?.textContent, message);
  assert(!host.textContent?.includes("扫码已由新请求替代或取消"));
  assert.equal(testDocument.querySelector("img"), null);
  assert(button("开始扫码授权").disabled, "A terminal state requires renewed consent");
  const checkbox = testDocument.querySelector("input") as HTMLInputElement;
  assert.equal(checkbox.disabled, false);
  assert.equal(checkbox.checked, false);
  await approve();
  assert.equal(button("开始扫码授权").disabled, false, "Renewed consent allows a new enrollment");
  const previousStarts = starts;
  await act(async () => button("开始扫码授权").click());
  assert.equal(starts, previousStarts + 1);
  remote = { state: "waiting", sessionId: `retry-${state}`, qrUrl: "https://example.test/retry", message: "retry" };
  await act(async () => resolveStart(remote));
  await tick();
  await act(async () => button("取消扫码").click());
}
await act(async () => root.unmount());
console.log("微信 QR UI PASS: consent, duplicate click, close during start, cancel, restart, completion, disconnect, expiry/error messages and renewed authorization (DOM only)");
