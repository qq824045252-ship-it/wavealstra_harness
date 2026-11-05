/**
 * chatSelections「加入聊天」桥接 Tests — Capture Mode → Chat 闭环（renderer 侧）
 *
 * 覆盖（本 Gate）：
 *   T1  attach 无 ACTIVE selection → 无操作（false）
 *   T2  attach ACTIVE selection → pending（指纹 + label + 聚焦 tick）
 *   T3  同页换元素并 attach → 累计两个 pending
 *   T4  页面清除 → 全部 stale
 *   T5  clearChatSelection(selection) → 只移除指定项
 *   T6  重复 attach 同一元素 → 去重并恢复 pending
 *   T7  sendMessage：多个 pending → prompt req.selections + 一次性消费
 *   T8  第二条消息 → req.selections 缺省（不无限复用）
 *   T9  stale 后发送 → req.selections 缺省（stale 不注入）
 *
 * 运行：pnpm test:chat-selection（纯 node；window.api.agent.prompt 为 mock）
 * 注：主进程侧解析语义（指纹匹配/stale/删除不注入）由 prompt-context-test C1-C6 覆盖。
 */
import { applySelectionMirror, useAppStore } from "../src/renderer/src/store/appStore";
import { EMPTY_SELECTION, type SelectionState } from "../src/shared/selection";
import type { AgentPromptRequest } from "../src/shared/agent-ipc";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

/** 与 prompt-context-test 同款 descriptor（art-A v3 gen7 backendNodeId 42） */
function makeDescriptor(overrides: Partial<NonNullable<SelectionState["descriptor"]>> = {}) {
  return {
    artifactId: "art-A",
    artifactVersion: 3,
    surfaceGeneration: 7,
    backendNodeId: 42,
    tagName: "div",
    id: "hero",
    classNames: ["card"],
    selector: "div#hero.card",
    text: "Run report",
    bounds: { x: 10, y: 20, width: 320, height: 48 },
    ...overrides,
  };
}

function makeActive(overrides: Partial<NonNullable<SelectionState["descriptor"]>> = {}): SelectionState {
  return { descriptor: makeDescriptor(overrides), status: "active", updatedAt: 0 };
}

let capturedReq: AgentPromptRequest | null = null;
function resetCapturedRequest(): void { capturedReq = null; }

function resetStore(): void {
  useAppStore.setState({
    selection: { ...EMPTY_SELECTION },
    chatSelections: [],
    chatFocusTick: 0,
    activeTaskId: null,
    tasks: [],
    draft: null,
  });
}

async function main(): Promise<void> {
  // window.api 需要在 import appStore 之后、sendMessage 之前挂上（theme 初始值依赖 typeof window）
  (globalThis as unknown as { window: unknown }).window = {
    api: {
      agent: {
        prompt: async (req: AgentPromptRequest): Promise<void> => {
          capturedReq = req;
        },
      },
    },
  };

  // ---------- attach 基础 ----------
  {
    resetStore();
    const ok = useAppStore.getState().attachSelectionToChat();
    check("T1 无 ACTIVE selection → attach 无操作", ok === false && useAppStore.getState().chatSelections.length === 0);
  }
  {
    resetStore();
    applySelectionMirror(makeActive());
    const ok = useAppStore.getState().attachSelectionToChat();
    const cs = useAppStore.getState().chatSelections[0];
    check(
      "T2 ACTIVE → pending + 指纹/label/聚焦 tick",
      ok === true &&
        cs?.status === "pending" &&
        cs.label === "div#hero.card" &&
        cs.artifactId === "art-A" &&
        cs.artifactVersion === 3 &&
        cs.surfaceGeneration === 7 &&
        cs.backendNodeId === 42 &&
        useAppStore.getState().chatFocusTick === 1,
      cs ? JSON.stringify({ label: cs.label, status: cs.status, tick: useAppStore.getState().chatFocusTick }) : "null",
    );
  }

  // ---------- 失效判定（applySelectionMirror = initRuntime 订阅同路径） ----------
  {
    resetStore();
    applySelectionMirror(makeActive());
    useAppStore.getState().attachSelectionToChat();
    // 同页换了元素：旧引用保持 pending，新元素可以继续加入
    applySelectionMirror(makeActive({ backendNodeId: 999, tagName: "button", id: "submit" }));
    useAppStore.getState().attachSelectionToChat();
    const selections = useAppStore.getState().chatSelections;
    check(
      "T3 同页换元素后继续 attach → 两个 pending",
      selections.length === 2 &&
        selections[0]?.backendNodeId === 42 && selections[0]?.status === "pending" &&
        selections[1]?.backendNodeId === 999 && selections[1]?.status === "pending",
      JSON.stringify(selections.map((item) => ({ id: item.backendNodeId, status: item.status }))),
    );
  }
  {
    resetStore();
    applySelectionMirror(makeActive());
    useAppStore.getState().attachSelectionToChat();
    applySelectionMirror({ ...EMPTY_SELECTION, status: "empty", updatedAt: 1 });
    check("T4 selection 清除 → 全部 stale", useAppStore.getState().chatSelections.every((item) => item.status === "stale"));
  }
  {
    resetStore();
    applySelectionMirror(makeActive());
    useAppStore.getState().attachSelectionToChat();
    applySelectionMirror(makeActive({ backendNodeId: 999 }));
    useAppStore.getState().attachSelectionToChat();
    const first = useAppStore.getState().chatSelections[0]!;
    useAppStore.getState().clearChatSelection(first);
    check(
      "T5 clearChatSelection(selection) → 只移除指定项",
      useAppStore.getState().chatSelections.length === 1 &&
        useAppStore.getState().chatSelections[0]?.backendNodeId === 999,
    );
  }
  {
    resetStore();
    applySelectionMirror(makeActive());
    useAppStore.getState().attachSelectionToChat();
    // 重复加入同一元素不产生重复 chip
    useAppStore.getState().attachSelectionToChat();
    check(
      "T6 重复 attach 同一元素 → 去重",
      useAppStore.getState().chatSelections.length === 1 &&
        useAppStore.getState().chatSelections[0]?.status === "pending" &&
        useAppStore.getState().chatSelections[0]?.backendNodeId === 42,
    );
  }

  {
    resetStore();
    applySelectionMirror(makeActive());
    useAppStore.getState().attachSelectionToChat("  改成蓝色  ");
    useAppStore.getState().attachSelectionToChat();
    check("备注去空白且直接重复添加保留备注", useAppStore.getState().chatSelections[0]?.comment === "改成蓝色");
    applySelectionMirror(makeActive({ backendNodeId: 999 }));
    useAppStore.getState().attachSelectionToChat("移到右侧");
    resetCapturedRequest();
    await useAppStore.getState().sendMessage("按备注修改");
    check("多个元素的备注随各自指纹发送", capturedReq?.selections?.[0]?.comment === "改成蓝色" && capturedReq?.selections?.[1]?.comment === "移到右侧");
    check("发送后备注随引用一起消费", useAppStore.getState().chatSelections.length === 0);
  }

  // ---------- sendMessage 消费语义 ----------
  {
    resetStore();
    applySelectionMirror(makeActive());
    useAppStore.getState().attachSelectionToChat();
    applySelectionMirror(makeActive({ backendNodeId: 999 }));
    useAppStore.getState().attachSelectionToChat();
    resetCapturedRequest();
    await useAppStore.getState().sendMessage("把这个按钮改成蓝色");
    check(
      "T7 发送：多个 pending → req.selections + 发送即消费",
      capturedReq?.selections?.length === 2 &&
        capturedReq.selections[0]?.backendNodeId === 42 &&
        capturedReq.selections[1]?.backendNodeId === 999 &&
        useAppStore.getState().chatSelections.length === 0,
      capturedReq?.selections ? JSON.stringify(capturedReq.selections) : "no selections in req",
    );
  }
  {
    // 上一条已消费：第二条消息不带 selections（不无限复用）
    resetCapturedRequest();
    await useAppStore.getState().sendMessage("再帮我看一下布局");
    check(
      "T8 第二条消息 → req.selections 缺省（不无限复用旧 selections）",
      capturedReq?.selections === undefined,
      capturedReq?.selections ? JSON.stringify(capturedReq.selections) : "undefined ✓",
    );
  }
  {
    // stale 后发送：renderer 侧直接跳过（不把失效引用发给主进程）
    resetStore();
    applySelectionMirror(makeActive());
    useAppStore.getState().attachSelectionToChat();
    applySelectionMirror({ ...EMPTY_SELECTION, status: "empty", updatedAt: 1 });
    resetCapturedRequest();
    await useAppStore.getState().sendMessage("这个元素还能改吗");
    check(
      "T9 stale 后发送 → req.selections 缺省 + chatSelections 已清",
      capturedReq?.selections === undefined && useAppStore.getState().chatSelections.length === 0,
    );
  }

  const failed = results.filter(([, pass]) => !pass);
  console.log("");
  console.log(`===== ChatSelection 桥接: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map(([n]) => n).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[chat-selection-test] 异常:", e);
  process.exit(1);
});
