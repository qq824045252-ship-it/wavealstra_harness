import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) return { url: "data:text/javascript,export default {}", shortCircuit: true };
  return next(specifier, context);
} });
import { gatewayRecordStatus, mergeGatewayRecords } from "../src/renderer/src/lib/gatewayPresentation";
const { window: w, document: d } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: w, document: d, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(w, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), localStorage: { getItem: () => null, setItem() {} } });
const { default: AssistantPage } = await import("../src/renderer/src/components/pages/AssistantPage");
const { createRoot } = await import("react-dom/client");
const tick = async () => { await act(async () => { await new Promise(r => setTimeout(r, 10)); }); };
const record = (chatId: string, text: string, at: number, direction: "in" | "out" | "system" = "out") => ({ id: at, channelId: "qq-default", chatId, text, at, direction });
const failed = record("a", "处理失败：独立 Bot 模式已移除；原 Bot 渠道绑定不再执行任务。", 1);
assert(!gatewayRecordStatus(failed).includes("已完成"));
assert.equal(gatewayRecordStatus({ ...failed, direction: "system" }), "渠道事件");
assert.equal(gatewayRecordStatus({ ...failed, direction: "in" }), "已收到");
assert.equal(mergeGatewayRecords([failed], [{ ...failed, id: 999 }]).length, 1);
assert.equal(mergeGatewayRecords([failed], [{ ...failed, text: "other" }]).length, 2);
let statusFails = false;
let listener: ((event: any) => void) | undefined;
const requests: { args: any; resolve: (rows: any[]) => void }[] = [];
Object.assign(w, { api: { gateway: {
 listMessages: (args: any) => new Promise(resolve => requests.push({ args, resolve })),
 status: async () => { if (statusFails) throw new Error("offline"); return { channels: [{ id: "qq-default", name: "QQ", connected: true }] }; },
 onEvent: (fn: any) => { listener = fn; return () => { listener = undefined; }; },
} } });
const host = d.body.appendChild(d.createElement("div")); const root = createRoot(host);
await act(async () => root.render(<AssistantPage />)); await tick();
await act(async () => listener?.(failed)); await tick();
assert(host.textContent?.includes(failed.text));
assert(!host.textContent?.includes("已完成"), "gateway error text must not receive a task-success badge");
assert(host.textContent?.includes("执行与送达状态未提供"));
await act(async () => requests[0].resolve([failed, record("b", "second", 2)])); await tick();
assert.equal(host.querySelectorAll(".assistant-conv-item").length, 2);
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".assistant-conv-item")];
await act(async () => buttons().find(b => b.textContent?.includes("second"))!.click()); await tick();
const bRequest = requests.find(r => r.args.chatId === "b")!;
await act(async () => bRequest.resolve([record("b", "current conversation", 3)])); await tick();
const aRequest = requests.find(r => r.args.chatId === "a")!;
await act(async () => aRequest.resolve([record("a", "stale response", 4)])); await tick();
assert(host.querySelector(".message-list")?.textContent?.includes("current conversation"));
assert(!host.querySelector(".message-list")?.textContent?.includes("stale response"));
statusFails = true;
await act(async () => listener?.(record("b", "status changed", 5, "system"))); await tick();
assert(host.textContent?.includes("连接状态未知"));
assert(!host.querySelector(".assistant-conn-hint")?.textContent?.includes("QQ已连接"));
await act(async () => root.unmount()); assert.equal(listener, undefined);

const { DesktopSectionProvider } = await import("../src/renderer/src/components/desktop/DesktopSection");
const desktopHost = d.body.appendChild(d.createElement("div"));
const sectionHost = d.body.appendChild(d.createElement("aside"));
const desktopRoot = createRoot(desktopHost);
const renderDesktop = async (showAssistant: boolean): Promise<void> => {
  statusFails = false;
  await act(async () => desktopRoot.render(
    <DesktopSectionProvider target={sectionHost}>
      {showAssistant ? <AssistantPage /> : <p>其他模块</p>}
    </DesktopSectionProvider>,
  ));
  await tick();
};
const history = [record("a", "first conversation", 10), record("b", "second conversation", 11)];
const firstMount = requests.length;
await renderDesktop(true);
await act(async () => requests[firstMount].resolve(history)); await tick();
assert.equal(sectionHost.querySelector("h2")?.textContent, "助手");
assert.equal(desktopHost.querySelector(".assistant-conv-list"), null);
const firstConversation = sectionHost.querySelector<HTMLButtonElement>('[aria-label="QQ · a"]');
assert(firstConversation);
await act(async () => firstConversation.click()); await tick();
assert(desktopHost.querySelector(".message-list")?.textContent?.includes("first conversation"));
await renderDesktop(false);
assert(desktopHost.textContent?.includes("其他模块"));
assert.equal(sectionHost.querySelector("h2"), null);

const secondMount = requests.length;
await renderDesktop(true);
await act(async () => requests[secondMount].resolve(history)); await tick();
assert.equal(sectionHost.querySelector('[aria-current="true"]')?.getAttribute("aria-label"), "QQ · a");
assert(desktopHost.querySelector(".message-list")?.textContent?.includes("first conversation"));
assert(!desktopHost.querySelector(".message-list")?.textContent?.includes("second conversation"));
await act(async () => desktopRoot.unmount());
assert.equal(listener, undefined);

console.log("Gateway presentation PASS: stable selection, history/live dedupe, late response isolation and desktop conversation restore");
