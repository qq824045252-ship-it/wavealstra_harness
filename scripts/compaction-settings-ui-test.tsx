/** Headless UI test: 设置页「上下文管理方式」在 billion-context / Pi 原生之间切换并保存。 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const settings = {
  compactionTriggerRatio: 0.8,
  compactionTriggerTokens: 200_000,
  compactionEngine: "billion-context",
  theme: "dark",
};
let saved: Record<string, unknown> | undefined;
Object.assign(window as unknown as { api: unknown }, {
  api: {
    agent: {
      getAppSettings: async () => ({ ...settings }),
      updateAppSettings: async (partial: Record<string, unknown>) => {
        saved = partial;
        Object.assign(settings, partial);
        return { ...settings };
      },
      getCompactionStatus: async (taskId: string) => ({ taskId, status: "skipped", reason: "manual", engine: "native", message: "没有可整理的历史" }),
    },
  },
});

async function main(): Promise<void> {
const { useAppStore } = await import("../src/renderer/src/store/appStore");
const { default: CompactionSettingsControl } = await import("../src/renderer/src/components/settings/CompactionSettingsControl");
const { createRoot } = await import("react-dom/client");

useAppStore.setState({ activeTaskId: "task-ui-test" });
const root = createRoot(document.getElementById("root")!);
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };
const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(button => button.textContent?.includes(text)) as HTMLButtonElement | undefined;
  assert(found, `找不到按钮：${text}（现有：${[...document.querySelectorAll("button")].map(button => button.textContent).join(" / ")}）`);
  return found;
};

await act(async () => { root.render(<CompactionSettingsControl />); });
await flush();

const text = (): string => document.getElementById("root")?.textContent ?? "";
assert(text().includes("分层摘要"), `默认应显示分层摘要引擎：${text().slice(0, 400)}`);
assert(text().includes("billion-context"), "默认引擎说明必须提到 billion-context");
const bcButton = buttonByText("分层摘要（billion-context）");
const nativeButton = buttonByText("按比例压缩（Pi 原生）");
assert(bcButton.className.includes("active"), "默认应选中分层摘要");
assert(!nativeButton.className.includes("active"), "默认不应选中按比例压缩");

await act(async () => { nativeButton.click(); });
await flush();
assert(nativeButton.className.includes("active"), "点击后应选中按比例压缩");
assert(text().includes("不提供按引用的原文回查"), "native 说明必须说明没有原文回查");

await act(async () => { buttonByText("保存压缩设置").click(); });
await flush();
assert(saved, "保存必须调用 updateAppSettings");
assert.equal(saved!.compactionEngine, "native", `保存必须写入 compactionEngine=native：${JSON.stringify(saved)}`);
assert.equal(saved!.compactionTriggerRatio, 0.8, "保存必须同时保留阈值比例");
assert.equal(saved!.compactionTriggerTokens, 200_000, "保存必须同时保留绝对阈值");
console.log("PASS compaction settings UI: default billion-context, switch to native, persist via updateAppSettings");

// 重新挂载：持久化后的 native 选择必须回显，实时状态引擎展示 Pi 原生压缩。
settings.compactionEngine = "native";
await act(async () => { root.render(<CompactionSettingsControl />); });
await flush();
assert(buttonByText("按比例压缩（Pi 原生）").className.includes("active"), "重新加载后应回显 native 选择");
assert(text().includes("Pi 原生压缩"), `当前引擎必须显示实时 native 状态：${text().slice(0, 500)}`);
console.log("PASS compaction settings UI: persisted native engine and live engine label");

await act(async () => { root.unmount(); });
console.log("compaction settings UI test passed");

// 手动控件：skipped 与按钮文案（GUI e2e 之外的 headless 复核）。
const { default: ManualCompactionControl } = await import("../src/renderer/src/components/chat/ManualCompactionControl");
useAppStore.setState({ activeTaskId: "task-ui-test", compactionByTask: { "task-ui-test": { taskId: "task-ui-test", status: "skipped", reason: "manual", message: "没有可整理的历史" } } });
const manualRoot = createRoot(document.getElementById("root")!);
await act(async () => { manualRoot.render(<ManualCompactionControl taskId="task-ui-test" executing={false} contextWindow={128_000} />); });
await flush();
const manualText = (): string => document.getElementById("root")?.textContent ?? "";
assert(manualText().includes("没有可整理的历史"), `skipped 必须显示没有可整理的历史：${manualText()}`);
assert(buttonByText("立即整理上下文"), "按钮文案必须是立即整理上下文");
assert(!manualText().includes("已压缩：— → —"), "skipped 不得伪报已压缩结果");
await act(async () => { manualRoot.unmount(); });
console.log("PASS manual compaction UI: skipped state and renamed labels");
}

void main().catch(error => { console.error(error); process.exit(1); });