/**
 * Real-render fixture for the multi-model-consult card: the actual component, the real
 * global.css + component CSS, a real ToolCall/report shape. The runner (consult-card-ui-test.cjs)
 * drives it through the DOM and asserts behaviour, never source text.
 */
import "../src/renderer/src/styles/global.css";
import React from "react";
import { createRoot } from "react-dom/client";
import MultiModelConsultCard from "../src/renderer/src/components/chat/MultiModelConsultCard";
import { appendCalls, state as storeState } from "./consult-card-store-stub";

interface StopCall { taskId: string; consultId: string; workerIndex: number }
// 帧等待：rAF 在不可见窗口里可能永不触发（无合成器的 Linux），用定时器兜底。
const nextFrame = () =>
  Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 50)),
  ]);
const twoFrames = () =>
  Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);

const stopCalls: StopCall[] = [];
(window as unknown as { api: unknown }).api = {
  agent: {
    stopConsultWorker: async (req: StopCall) => { stopCalls.push(req); return true; },
  },
};

const now = Date.now();
const trace = (id: string, name: string, status: string, args: unknown, output?: string, truncated = false) =>
  ({ id, name, status, arguments: args, ...(output ? { output } : {}), ...(truncated ? { outputTruncated: true } : {}) });

const COMPLETE_REPORT = {
  schemaVersion: 1 as const, id: "tool-consult-1", taskId: "task-consult",
  task: "审查财务核心核算代码并提出证据", startedAt: now - 9000, endedAt: now - 1000,
  status: "complete" as const, expected: 3, succeeded: 2,
  workers: [
    {
      modelId: "google-vertex/gemini-3.8-flash", modelName: "Gemini 3.8 Flash", thinkingLevel: "high",
      status: "complete" as const, startedAt: now - 9000, endedAt: now - 6000,
      answer: "基于对核算代码的独立审查：BigInt 整数分转换正确，但存在「借贷试算平衡」与「会计实质合规」的边界混淆。",
      tools: [
        trace("t1", "read", "success", { path: "src/vat/vat-accounting.ts" }, "export function vatAccounting() {}"),
        trace("t2", "grep", "success", { pattern: "totalDebit" }, "x".repeat(900), true),
      ],
      tokens: { input: 1200, output: 800, cacheRead: 40, cacheWrite: 0 },
    },
    {
      modelId: "commandcode/deepseek/deepseek-v4.1-flash", modelName: "DeepSeek V4.1 Flash", thinkingLevel: "max",
      status: "complete" as const, startedAt: now - 9000, endedAt: now - 5000,
      answer: "第二个模型的独立意见：凭证生成逻辑本身自洽，风险主要在缺失的审计留痕。",
      tools: [], tokens: { input: 900, output: 600, cacheRead: 0, cacheWrite: 0 },
    },
    {
      modelId: "glm/glm-5.3-flash", modelName: "GLM-5.3-Flash", thinkingLevel: "max",
      status: "error" as const, startedAt: now - 9000, endedAt: now - 1000,
      answer: "", error: "供应商返回 429：请求被限流，未返回答案。", tools: [],
    },
  ],
};

/** The parent tool call already settled while the report still says "running" (the interrupted case). */
const INTERRUPTED_REPORT = {
  ...COMPLETE_REPORT, id: "tool-consult-2", status: "running" as const, endedAt: undefined, succeeded: 1,
  workers: [
    { ...COMPLETE_REPORT.workers[0]!, status: "complete" as const },
    { ...COMPLETE_REPORT.workers[1]!, status: "running" as const, endedAt: undefined, answer: "尚未结束的部分意见", tokens: undefined,
      tools: [trace("t3", "read", "running", { path: "src/voucher/voucherService.ts" })] },
    { ...COMPLETE_REPORT.workers[2]!, status: "queued" as const, startedAt: undefined, endedAt: undefined, answer: "", error: undefined },
  ],
};

/** Still-live consultation: participants are generating, so they must expose a direct terminate. */
const LIVE_REPORT = {
  ...COMPLETE_REPORT, id: "tool-consult-3", status: "running" as const, endedAt: undefined, succeeded: 0,
  workers: [
    { ...COMPLETE_REPORT.workers[0]!, status: "running" as const, endedAt: undefined, answer: "正在分析…", tools: [trace("t4", "read", "running", { path: "src/vat/vat-accounting.ts" })] },
    { ...COMPLETE_REPORT.workers[1]!, status: "queued" as const, startedAt: undefined, endedAt: undefined, answer: "", tools: [], tokens: undefined },
  ],
};

const FIXTURES: Record<string, { status: string; report: unknown }> = {
  complete: { status: "success", report: COMPLETE_REPORT },
  interrupted: { status: "success", report: INTERRUPTED_REPORT },
  live: { status: "running", report: LIVE_REPORT },
};

const root = createRoot(document.querySelector("#root")!);
function render(kind: string): void {
  const fixture = FIXTURES[kind]!;
  root.render(<MultiModelConsultCard key={kind} toolCall={{ id: (fixture.report as { id: string }).id, tool: "multi_model_consult", status: fixture.status, output: "", consult: fixture.report } as never} />);
}

const rect = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
};

(window as unknown as { consultCardTest: unknown }).consultCardTest = {
  render,
  openDetails: () => (document.querySelector("[data-testid=consult-open-details]") as HTMLElement).click(),
  closeDetails: () => (document.querySelector("[data-testid=consult-close-details]") as HTMLElement).click(),
  dialogOpen: () => Boolean(document.querySelector("dialog.consult-dialog[open]")),
  dialogRect: () => rect("dialog.consult-dialog"),
  bodyDirection: () => {
    const body = document.querySelector(".consult-dialog-body");
    return body ? getComputedStyle(body).flexDirection : null;
  },
  tabs: () => [...document.querySelectorAll(".consult-tabs [role=tab]")].map((tab) => tab.textContent ?? ""),
  clickTab: (index: number) => (document.querySelectorAll(".consult-tabs [role=tab]")[index] as HTMLElement).click(),
  rawAnswer: () => document.querySelector("[data-testid=consult-raw-answer]")?.textContent ?? null,
  workerRows: () => [...document.querySelectorAll("[data-testid^=consult-worker-]")].map((row) => row.textContent ?? ""),
  stopButtons: () => [...document.querySelectorAll("[data-testid^=consult-stop-]")].map((button) => button.textContent ?? ""),
  clickStop: (index: number) => (document.querySelector(`[data-testid=consult-stop-${index}]`) as HTMLElement).click(),
  stopCalls: () => stopCalls,
  followupState: () => {
    const button = document.querySelector("[data-testid=consult-followup]") as HTMLButtonElement | null;
    return { present: Boolean(button), disabled: button?.disabled ?? null, label: button?.textContent ?? null };
  },
  clickFollowup: () => (document.querySelector("[data-testid=consult-followup]") as HTMLButtonElement).click(),
  dragBy: async (dx: number, dy: number) => {
    const heading = document.querySelector(".consult-dialog-heading") as HTMLElement;
    const dialog = document.querySelector("dialog.consult-dialog") as HTMLElement;
    const box = heading.getBoundingClientRect();
    const origin = dialog.getBoundingClientRect();
    const startX = box.left + 20;
    const startY = box.top + 10;
    heading.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: startX, clientY: startY, pointerId: 1, isPrimary: true }));
    // React commits the drag state (and installs its window listeners) on the next frame.
    // 隐藏窗口在无合成器的 Linux 上 rAF 可能永不触发 → 定时器兜底，避免整条用例挂死。
    await twoFrames();
    for (const step of [0.5, 1]) {
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX + dx * step, clientY: startY + dy * step, pointerId: 1, isPrimary: true }));
      await nextFrame();
    }
    // 隐藏窗口/高负载下合成的 pointermove 可能被合并或丢掉（CI 实测只吃到了 0.5 那一步）。
    // 拖动处理器按「绝对位置」计算且幂等，所以重复发最终位置直到面板真的到位；最多 8 次。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const moved = dialog.getBoundingClientRect();
      if (Math.abs(moved.left - (origin.left + dx)) < 2 && Math.abs(moved.top - (origin.top + dy)) < 2) break;
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: startX + dx, clientY: startY + dy, pointerId: 1, isPrimary: true }));
      await nextFrame();
    }
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: startX + dx, clientY: startY + dy, pointerId: 1, isPrimary: true }));
  },
  recenter: () => document.querySelector(".consult-dialog-heading")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  appended: () => appendCalls,
  notice: () => document.querySelector(".consult-followup-notice")?.textContent ?? null,
  setActiveTask: (taskId: string | null) => { storeState.activeTaskId = taskId; },
};

render("complete");
