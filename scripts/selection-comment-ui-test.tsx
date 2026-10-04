import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import CaptureModeStatus from "../src/renderer/src/components/artifact/CaptureModeStatus";
import { applySelectionMirror, useAppStore } from "../src/renderer/src/store/appStore";
import type { SelectionState } from "../src/shared/selection";

export function run(): string[] {
  const results: string[] = [];
  const check = (name: string, ok: boolean): void => { if (!ok) throw new Error(name); results.push(name); };
  const selection: SelectionState = { status: "active", updatedAt: 1, descriptor: {
    artifactId: "art-test", artifactVersion: 1, surfaceGeneration: 1, backendNodeId: 42,
    tagName: "button", id: "submit", classNames: ["primary"], selector: "button#submit.primary",
    text: "提交", bounds: { x: 10, y: 20, width: 80, height: 32 },
  } };
  useAppStore.setState({ selection, chatSelections: [], activeTaskId: null });
  const container = document.createElement("div");
  container.style.width = "360px";
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<CaptureModeStatus captureState={{ state: "idle" }} />));
  const click = (label: string): void => {
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
    if (!button) throw new Error(`Missing button ${label}`);
    flushSync(() => button.click());
  };
  const enterComment = (value: string): void => {
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    flushSync(() => textarea.dispatchEvent(new Event("input", { bubbles: true })));
  };
  click("评论到对话");
  check("备注框获得焦点", document.activeElement === container.querySelector("textarea"));
  check("空备注禁止提交", container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled);
  enterComment("把这个按钮改成蓝色");
  click("添加评论");
  check("备注加入真实 store 且编辑框收起", useAppStore.getState().chatSelections[0]?.comment === "把这个按钮改成蓝色" && !container.querySelector("textarea"));
  click("评论到对话");
  check("重新打开保留备注", container.querySelector("textarea")!.value === "把这个按钮改成蓝色");
  enterComment("不能串到下一位置");
  flushSync(() => applySelectionMirror({ ...selection, descriptor: { ...selection.descriptor!, backendNodeId: 99, id: "cancel" } }));
  check("切换抓取位置关闭旧备注框", !container.querySelector("textarea"));
  click("评论到对话");
  check("新位置没有旧备注", container.querySelector("textarea")!.value === "");
  enterComment("第二个位置");
  flushSync(() => container.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  check("Ctrl+Enter 添加独立备注", useAppStore.getState().chatSelections.length === 2 && useAppStore.getState().chatSelections[1]?.comment === "第二个位置");
  click("评论到对话");
  flushSync(() => applySelectionMirror({ ...selection, status: "stale", staleReason: "surface-generation-changed" }));
  check("页面失效时关闭备注入口", !container.querySelector("textarea") && !container.querySelector(".capture-selection-actions"));
  flushSync(() => applySelectionMirror(selection));
  click("评论到对话");
  check("窄面板无水平溢出", container.scrollWidth <= 360);
  return results;
}
