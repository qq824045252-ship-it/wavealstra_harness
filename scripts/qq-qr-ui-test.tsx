import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import QQGatewaySettings from "../src/renderer/src/components/settings/QQGatewaySettings";
import type { GatewayQQQrLoginStateDto } from "../src/shared/agent-ipc";

const { window: testWindow, document: testDocument } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: testWindow, document: testDocument, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const tick = async (ms = 20) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); };
let resolveStart!: (value: GatewayQQQrLoginStateDto) => void;
let starts = 0, disconnects = 0, connected = false;
const cancelled: Array<string | undefined> = [];
let remote: GatewayQQQrLoginStateDto = { state: "idle", message: "idle" };
Object.assign(testWindow, { api: { gateway: {
  status: async () => ({ channels: [{ id: "qq-default", connected }] }),
  qqQrStart: async (approved: boolean) => { assert.equal(approved, true); starts++; return new Promise<GatewayQQQrLoginStateDto>(resolve => { resolveStart = resolve; }); },
  qqQrState: async () => remote,
  qqQrCancel: async (id?: string) => { cancelled.push(id); return { state: "cancelled", sessionId: id, message: "cancelled" }; },
  disconnect: async () => { disconnects++; connected = false; },
} } });
const host = testDocument.body.appendChild(testDocument.createElement("div"));
let root = createRoot(host);
const button = (text: string) => Array.from(testDocument.querySelectorAll("button")).find(value => value.textContent === text) as HTMLButtonElement;
const mount = async () => { await act(async () => { root.render(<QQGatewaySettings />); }); await tick(); await act(async () => button("配置").click()); };
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
assert(testDocument.querySelector('img[alt="QQ 官方授权二维码"]'));
await act(async () => button("取消扫码").click());
assert.equal(cancelled.at(-1), "live"); assert.equal(testDocument.querySelector("img"), null);
assert(button("开始扫码授权").disabled);

await approve(); await act(async () => button("开始扫码授权").click());
remote = { state: "waiting", sessionId: "complete", qrUrl: "https://q.qq.com/test", message: "scan" };
await act(async () => resolveStart(remote)); await tick();
connected = true; remote = { state: "connected", sessionId: "complete", message: "connected", appId: "123" };
await tick(1100);
assert.equal(testDocument.querySelector("img"), null);
assert.equal(button("管理").getAttribute("aria-expanded"), "false");
await act(async () => button("管理").click());
assert.equal(button("断开 QQ").disabled, false);
assert.equal(button("开始扫码授权"), undefined);
await act(async () => button("断开 QQ").click());
assert.equal(disconnects, 1);
await act(async () => root.unmount());
console.log("QQ QR UI PASS: consent, duplicate click, close during start, cancel, restart, completion and disconnect (DOM only)");
