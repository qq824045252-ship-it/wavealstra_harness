/**
 * BTW（临时上下文分支）隔离性单测。
 *
 * 验证核心契约：
 * - BTW 消息只存在于 btwStore.ephemeral messages，绝不写入 Task.messages；
 * - btw:event 补丁按 btwId 路由，id 不匹配一律丢弃（不进主任务 reducer）；
 * - 多轮追问：Q1→A1→Q2→A2 在同一个 BTW session 内；
 * - 关闭即销毁：close 后状态清空、后续补丁丢弃、主进程 close 被调用；
 * - 切换父任务停止观察，切回使用原身份恢复；
 * - 带回主线只填主 Composer（composerDraft），不直接写 Task.messages；
 * - 消息/会话 id 使用 btw-* 前缀，与主任务 id 空间隔离。
 */
import assert from "node:assert/strict";
import type { BtwUiPatch } from "../src/shared/agent-ipc";
import { BTW_MAX_SESSIONS, canStartBtwSession } from "../src/shared/btw-policy";
import type { DurableBotSnapshot } from "../src/shared/durable-bot";
import { durableDelta } from "../shared/src/durable-sync";

// ---- Node 环境桩：window.api.btw 调用全部捕获；setInterval 不真实运行（避免挂起）----
const btwCalls: Record<string, unknown[][]> = { start: [], prompt: [], abort: [], close: [], keepalive: [] };
const browserStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => browserStorage.get(key) ?? null,
  setItem: (key: string, value: string) => { browserStorage.set(key, value); },
  removeItem: (key: string) => { browserStorage.delete(key); },
} });
(globalThis as unknown as { window: unknown }).window = {
  api: {
    btw: {
      start: (...args: unknown[]) => {
        btwCalls.start.push(args);
        return Promise.resolve();
      },
      prompt: (...args: unknown[]) => {
        btwCalls.prompt.push(args);
        return Promise.resolve();
      },
      abort: (...args: unknown[]) => {
        btwCalls.abort.push(args);
        return Promise.resolve();
      },
      close: (...args: unknown[]) => {
        btwCalls.close.push(args);
        return Promise.resolve();
      },
      keepalive: (...args: unknown[]) => {
        btwCalls.keepalive.push(args);
        return Promise.resolve();
      },
    },
  },
};
(globalThis as unknown as { setInterval: unknown }).setInterval = (() => 1) as unknown as typeof setInterval;
(globalThis as unknown as { clearInterval: unknown }).clearInterval = (() => undefined) as unknown as typeof clearInterval;

import {
  useBtwStore,
  btwComposerSendInput,
  isStreamingStalled,
  BTW_STREAMING_TIMEOUT_MS,
} from "../src/renderer/src/store/btwStore";
import { useAppStore } from "../src/renderer/src/store/appStore";
import type { ChatMessage, Task } from "../src/renderer/src/types";

function mkUserMessage(id: string, text: string): ChatMessage {
  return { id, role: "user", createdAt: 1, blocks: [{ type: "text", text }] };
}

function mkTask(id: string, messages: ChatMessage[], sessionFile?: string): Task {
  return { id, title: `任务 ${id}`, updatedAt: 1, messages, sessionFile };
}

/** 重置两个 store 到干净状态 */
function reset(): void {
  browserStorage.clear();
  useAppStore.setState({
    tasks: [],
    activeTaskId: null,
    composerDraft: null,
  });
  useBtwStore.setState({
    active: false,
    collapsed: false,
    started: false,
    starting: false,
    ready: false,
    pendingSend: null,
    streamingSince: null,
    lastBringBackUserMsgId: null,
    btwId: null,
    parentTaskId: null,
    startRequest: null,
    durable: undefined,
    snapshotAt: 0,
    messages: [],
    streaming: false,
    error: null,
    notice: null,
  });
  for (const key of Object.keys(btwCalls)) btwCalls[key]!.length = 0;
}

const mainUserMsg = mkUserMessage("m1", "主对话内容：帮我实现登录页");
const mainTask = mkTask("t1", [mainUserMsg], "/tmp/t1.jsonl");

let passed = 0;
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed += 1;
}

// ---- 场景 1：无主对话上下文时不可发起 BTW（home/空任务不强行 materialize）----
{
  reset();
  useAppStore.setState({ tasks: [mkTask("t0", [])], activeTaskId: "t0" });
  useBtwStore.getState().start();
  ok(!useBtwStore.getState().active, "1.1 空任务不可发起 BTW");
  ok(btwCalls.start.length === 0, "1.2 空任务不调用主进程 start");
}

// ---- 场景 2：有上下文时发起；id 空间隔离 ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  const st = useBtwStore.getState();
  ok(st.active, "2.1 BTW 激活");
  ok(st.btwId !== null && st.btwId.startsWith("btw-"), "2.2 btwId 使用 btw-* 前缀");
  ok(st.parentTaskId === "t1", "2.3 绑定创建时刻的父任务");
  ok(st.snapshotAt > 0, "2.4 记录快照时刻");
  ok(st.messages.length === 0 && !st.started, "2.5 首轮发送前无消息、面板未开始");
  ok(btwCalls.start.length === 1, "2.6 主进程 start 被调用");
  const startReq = btwCalls.start[0]![0] as { btwId: string; parentTaskId: string };
  ok(startReq.btwId === st.btwId && startReq.parentTaskId === "t1", "2.7 start 参数正确");
  // 重复 start 幂等
  useBtwStore.getState().start();
  ok(btwCalls.start.length === 1, "2.8 重复 start 幂等");
}

// ---- 场景 3：首轮发送 → 本地临时消息；streaming 中不可并发追问 ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1 这段逻辑会影响主对话吗？");
  let st = useBtwStore.getState();
  ok(st.started, "3.1 首轮后 started");
  ok(st.streaming, "3.2 streaming 中");
  ok(st.messages.length === 2, "3.3 用户+助手两条临时消息");
  ok(st.messages[0]!.role === "user" && st.messages[1]!.role === "assistant", "3.4 顺序：user → assistant");
  ok(st.messages[0]!.id.startsWith("btw-u-"), "3.5 用户消息 id btw-u-* 前缀");
  ok(st.messages[1]!.id.startsWith("btw-a-") && st.messages[1]!.streaming, "3.6 助手消息 id btw-a-* 且 streaming");
  ok(btwCalls.prompt.length === 1, "3.7 主进程 prompt 被调用");
  // streaming 中再发送被忽略
  useBtwStore.getState().send("Q2 并发追问");
  ok(useBtwStore.getState().messages.length === 2, "3.8 BTW 自身单轮串行：并发追问被忽略");
  ok(btwCalls.prompt.length === 1, "3.9 未产生第二个 prompt");
  // 主任务消息不受影响
  st = useBtwStore.getState();
  ok(useAppStore.getState().tasks.find((t) => t.id === "t1")!.messages.length === 1, "3.10 Task.messages 未被污染");
}

// ---- 场景 4：btw:event 补丁按 btwId 路由 + 完整终态（start/delta/end）----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1");
  const { btwId, messages } = useBtwStore.getState();
  const asstId = messages[1]!.id;
  const patch = (p: BtwUiPatch extends infer P ? P extends BtwUiPatch ? Omit<P, "btwId"> : never : never): BtwUiPatch => ({ ...p, btwId: btwId! });
  // 错误 btwId 一律丢弃
  useBtwStore.getState().applyBtwPatch({
    type: "text_delta",
    taskId: "other-btw",
    btwId: "btw-其他会话",
    messageId: asstId,
    delta: "不应出现",
  });
  ok(!useBtwStore.getState().messages[1]!.blocks.some((b) => b.type === "text"), "4.1 异会话补丁被丢弃");
  // 正常流：assistant_start → text_delta(过程) → text_delta(final) → assistant_end
  useBtwStore.getState().applyBtwPatch(patch({ type: "assistant_start", taskId: btwId!, messageId: asstId, modelName: "test-model" }));
  useBtwStore.getState().applyBtwPatch(patch({ type: "text_delta", taskId: btwId!, messageId: asstId, delta: "正在分析" }));
  useBtwStore.getState().applyBtwPatch(patch({ type: "text_delta", taskId: btwId!, messageId: asstId, delta: "结论：不进入主线", final: true }));
  useBtwStore.getState().applyBtwPatch(patch({ type: "assistant_end", taskId: btwId!, messageId: asstId }));
  const st = useBtwStore.getState();
  ok(st.messages[1]!.modelName === "test-model", "4.2 assistant_start 设置模型名");
  ok(!st.streaming, "4.3 assistant_end 结束 streaming（无悬挂）");
  const finalText = (st.messages[1]!.finalBlocks ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  ok(finalText === "结论：不进入主线", "4.4 final text_delta 进入 finalBlocks");
}

// ---- 场景 5：多轮追问（同一 session）----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1");
  const { btwId } = useBtwStore.getState();
  const asst1 = useBtwStore.getState().messages[1]!.id;
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asst1 });
  useBtwStore.getState().send("Q2 再问一轮");
  const st = useBtwStore.getState();
  ok(st.messages.length === 4, "5.1 第二轮产生 4 条消息（Q1 A1 Q2 A2）");
  ok(st.messages[3]!.id.startsWith("btw-a-"), "5.2 第二轮助手消息仍在 btw-* 空间");
  ok(st.btwId === btwId, "5.3 同一 session（btwId 不变）");
  ok(btwCalls.prompt.length === 2, "5.4 两次 prompt 均走 BTW 通道");
  ok(useAppStore.getState().tasks.find((t) => t.id === "t1")!.messages.length === 1, "5.5 多轮后 Task.messages 仍未被污染");
}

// ---- 场景 6：折叠不中断生成；关闭即销毁 ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1");
  const { btwId } = useBtwStore.getState();
  useBtwStore.getState().toggleCollapsed();
  ok(useBtwStore.getState().collapsed, "6.1 折叠");
  ok(useBtwStore.getState().streaming && useBtwStore.getState().messages.length === 2, "6.2 折叠不中断生成、不丢消息");
  useBtwStore.getState().expand();
  ok(!useBtwStore.getState().collapsed, "6.3 展开");
  useBtwStore.getState().close();
  const st = useBtwStore.getState();
  ok(!st.active && st.btwId === null && st.messages.length === 0 && !st.started, "6.4 关闭即销毁");
  ok(btwCalls.close.length >= 1 && btwCalls.close.some((c) => c[0] === btwId), "6.5 主进程 close 被调用且带 btwId（含在途 start 的补发 close）");
  // 关闭后旧 btwId 补丁一律丢弃
  useBtwStore.getState().applyBtwPatch({
    type: "text_delta",
    taskId: btwId!,
    btwId: btwId!,
    messageId: "btw-a-旧消息",
    delta: "残留",
  });
  ok(useBtwStore.getState().messages.length === 0, "6.6 关闭后补丁被丢弃");
}

// ---- 场景 7：切换父任务仅停止观察，切回恢复原身份 ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask, mkTask("t2", [mkUserMessage("m2", "另一个任务")])], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1");
  const originalBtwId = useBtwStore.getState().btwId;
  ok(useBtwStore.getState().active, "7.1 BTW 已激活");
  useBtwStore.getState().destroyIfParentChanged("t2");
  const st = useBtwStore.getState();
  ok(!st.active && st.messages.length === 0, "7.2 切换任务 → 清理观察界面");
  ok(btwCalls.close.length === 0 && btwCalls.abort.length === 0, "7.3 停止观察不取消后台执行");
  useBtwStore.getState().destroyIfParentChanged("t1");
  ok(useBtwStore.getState().active && useBtwStore.getState().btwId === originalBtwId, "7.4 原会话身份恢复");
}

// ---- 场景 8：带回主线只填 Composer（问题+精简结论），不写 Task.messages ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1 这段逻辑会污染主线吗？");
  const { btwId, messages } = useBtwStore.getState();
  const asstId = messages[1]!.id;
  useBtwStore.getState().applyBtwPatch({ type: "text_delta", taskId: btwId!, btwId: btwId!, messageId: asstId, delta: "关键结论 X", final: true });
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asstId });
  useBtwStore.getState().bringBackToComposer();
  const draft = useAppStore.getState().composerDraft;
  ok(typeof draft === "string", "8.1 结论已填入主 Composer");
  ok(draft!.includes("【BTW 结论】"), "8.2 带 BTW 来源前缀");
  ok(draft!.includes("问：Q1 这段逻辑会污染主线吗？"), "8.3 包含最后一条问题");
  ok(draft!.includes("答：关键结论 X"), "8.4 包含精简结论");
  ok(useAppStore.getState().tasks.find((t) => t.id === "t1")!.messages.length === 1, "8.5 Task.messages 未被写入");
  ok(useBtwStore.getState().active, "8.6 带回后 BTW 保留（用户可继续或自行关闭）");
}

// ---- 场景 8b：带回主线跳过未完成轮次；长回答被截断为精简结论 ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q 未完成轮");
  const { btwId, messages } = useBtwStore.getState();
  const asstId = messages[1]!.id;
  // 只发 streaming 中的 text_delta（无 assistant_end）→ 该轮不算已完成
  useBtwStore.getState().applyBtwPatch({ type: "text_delta", taskId: btwId!, btwId: btwId!, messageId: asstId, delta: "还在生成" });
  useBtwStore.getState().bringBackToComposer();
  ok(useAppStore.getState().composerDraft === null, "8b.1 未完成轮次不产生带回结论");
  ok((useBtwStore.getState().notice ?? "").includes("暂无已完成回答"), "8b.2 给出等待提示");
  // 完成该轮后再带回：长答案截断
  useBtwStore.getState().applyBtwPatch({ type: "text_delta", taskId: btwId!, btwId: btwId!, messageId: asstId, delta: "长".repeat(1500), final: true });
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asstId });
  useBtwStore.getState().bringBackToComposer();
  const draft2 = useAppStore.getState().composerDraft ?? "";
  ok(draft2.includes("答：") && draft2.length < 1500, "8b.3 长结论被截断（不整段灌入）");
  ok(draft2.endsWith("…") || draft2.endsWith("…"), "8b.4 截断有省略号标记");
}

// ---- 场景 10：主任务 streaming 并发 BTW（互不干扰、不串 delta）----
{
  reset();
  // 主任务正在生成：最后一条助手消息 streaming
  const streamingTask = mkTask("t1", [
    mkUserMessage("m1", "主问题"),
    {
      id: "m2",
      role: "assistant",
      createdAt: 2,
      blocks: [{ type: "text", text: "主线正在输出" }],
      streaming: true,
    },
  ], "/tmp/t1.jsonl");
  useAppStore.setState({ tasks: [streamingTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  ok(useBtwStore.getState().active, "10.1 主任务 streaming 时仍可发起 BTW");
  useBtwStore.getState().send("B 问题");
  const { btwId, messages: btwMsgs } = useBtwStore.getState();
  const asstId = btwMsgs[1]!.id;
  useBtwStore.getState().applyBtwPatch({ type: "text_delta", taskId: btwId!, btwId: btwId!, messageId: asstId, delta: "BTW 独立回答", final: true });
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asstId });
  // 主任务消息不变：仍 2 条、m2 仍 streaming（BTW 不碰主任务状态）
  const mainMsgs = useAppStore.getState().tasks.find((t) => t.id === "t1")!.messages;
  ok(mainMsgs.length === 2, "10.2 主任务消息数不变");
  ok(mainMsgs[1]!.streaming === true, "10.3 主任务 streaming 状态未被 BTW 补丁影响");
  ok((mainMsgs[1]!.blocks[0] as { text: string }).text === "主线正在输出", "10.4 主线 delta 未被 BTW 污染");
  // 主任务补丁（agent:event 通道）不进入 BTW：以主任务消息 id 伪造补丁应被丢弃
  useBtwStore.getState().applyBtwPatch({
    type: "text_delta",
    taskId: "t1",
    btwId: btwId!,
    messageId: "m2",
    delta: "不应进入 BTW",
  });
  const btwFinal = (useBtwStore.getState().messages[1]!.finalBlocks ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  ok(btwFinal === "BTW 独立回答", "10.5 主任务消息 id 的补丁无法串进 BTW（消息 id 空间隔离）");
}

// ---- 场景 11：BTW 会话上限策略（共享常量）----
{
  ok(BTW_MAX_SESSIONS > 0, "11.1 上限为正数");
  ok(canStartBtwSession(0, false) === true, "11.2 空载可新建");
  ok(canStartBtwSession(BTW_MAX_SESSIONS - 1, false) === true, "11.3 未达上限可新建");
  ok(canStartBtwSession(BTW_MAX_SESSIONS, false) === false, "11.4 达上限拒绝新建");
  ok(canStartBtwSession(BTW_MAX_SESSIONS, true) === true, "11.5 同 id 替换不占新名额");
}

// ---- 场景 9：abort 走独立通道 ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1");
  useBtwStore.getState().abort();
  ok(btwCalls.abort.length === 1 && btwCalls.abort[0]![0] === useBtwStore.getState().btwId, "9.1 abort 只作用于 BTW 自身 btwId");
  ok(useBtwStore.getState().active, "9.2 abort 不关闭会话（可继续追问）");
}

// ---- 场景 12：带回主线不覆盖已有 composerDraft ----
{
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1", composerDraft: "主线已有草稿" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1");
  const { btwId, messages } = useBtwStore.getState();
  const asstId = messages[1]!.id;
  useBtwStore.getState().applyBtwPatch({ type: "text_delta", taskId: btwId!, btwId: btwId!, messageId: asstId, delta: "结论 Y", final: true });
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asstId });
  useBtwStore.getState().bringBackToComposer();
  const draft = useAppStore.getState().composerDraft ?? "";
  ok(draft.includes("主线已有草稿"), "12.1 已有主线草稿不被覆盖");
  ok(draft.includes("---") && draft.includes("【BTW 结论】") && draft.includes("结论 Y"), "12.2 BTW 结论以分隔线追加");
  ok(draft.indexOf("主线已有草稿") < draft.indexOf("【BTW 结论】"), "12.3 原草稿在前、BTW 结论在后");
  ok(useAppStore.getState().tasks.find((t) => t.id === "t1")!.messages.length === 1, "12.4 Task.messages 仍未被动");
}

/** 可手动控制 resolve/reject 的 start 桩（模拟 IPC 在途） */
function installDeferredStart(): {
  resolve: () => void;
  reject: (e: Error) => void;
  restore: () => void;
} {
  let resolveFn: (() => void) | null = null;
  let rejectFn: ((e: Error) => void) | null = null;
  const api = (globalThis as unknown as { window: { api: { btw: { start: (...a: unknown[]) => Promise<void> } } } }).window.api;
  const original = api.btw.start;
  api.btw.start = (...args: unknown[]): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      btwCalls.start.push(args);
      resolveFn = resolve;
      rejectFn = reject;
    });
  return {
    resolve: () => resolveFn?.(),
    reject: (e: Error) => rejectFn?.(e),
    restore: () => {
      api.btw.start = original;
    },
  };
}

// ---- 场景 13：start 在途时 close → UI 立即退出、主进程最终被清理、不复活 ----
async function scenarioStartInFlightClose(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  const deferred = installDeferredStart();
  useBtwStore.getState().start();
  const st1 = useBtwStore.getState();
  ok(st1.active && st1.btwId !== null, "13.1 start 在途时 BTW 已进入激活态");
  const btwId = st1.btwId!;
  useBtwStore.getState().close();
  ok(!useBtwStore.getState().active, "13.2 close 立即退出 UI（不等待主进程）");
  deferred.resolve();
  await new Promise((r) => setTimeout(r, 0)); // flush 微任务（start.then 补发 close）
  ok(
    btwCalls.close.some((c) => c[0] === btwId),
    "13.3 主进程收到 close（close 自身或 start 完成后补发）",
  );
  const st = useBtwStore.getState();
  ok(!st.active && st.btwId === null && st.messages.length === 0, "13.4 start 完成后不复活已关闭 BTW");
  deferred.restore();
}

// ---- 场景 14：旧 start 失败被 close/新 start 取代 → 不污染新会话 ----
async function scenarioStaleStartRejected(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  const deferred = installDeferredStart();
  useBtwStore.getState().start();
  const btwIdA = useBtwStore.getState().btwId!;
  useBtwStore.getState().close();
  deferred.restore();
  useBtwStore.getState().start();
  const btwIdB = useBtwStore.getState().btwId!;
  ok(btwIdB !== btwIdA, "14.1 新会话使用新 btwId");
  deferred.reject(new Error("boom")); // 旧 A 的 start 在途失败
  await new Promise((r) => setTimeout(r, 0));
  const st = useBtwStore.getState();
  ok(st.active && st.btwId === btwIdB, "14.2 旧 start 失败不影响新会话激活态");
  ok(st.error === null, "14.3 旧 start 失败不写入新会话 error（代际隔离）");
  useBtwStore.getState().send("B 问题");
  ok(useBtwStore.getState().messages.length === 2, "14.4 新会话仍可正常发送");
}

// ---- 场景 15：BTW 发送路由纯函数（ChatInput 消费同一函数；空文本/门控/trim）----
{
  ok(btwComposerSendInput(false, "主线草稿") === null, "15.1 BTW 未激活时路由拒绝（绝不消费主线 text）");
  ok(btwComposerSendInput(true, "") === null, "15.2 空文本拒绝");
  ok(btwComposerSendInput(true, "   ") === null, "15.3 纯空白拒绝");
  ok(btwComposerSendInput(true, "临时问题") === "临时问题", "15.4 非空文本通过");
  ok(btwComposerSendInput(true, "  临时问题  ") === "临时问题", "15.5 trim 后通过");
}

/** 可手动控制 resolve/reject 的 prompt 桩（模拟 IPC 在途） */
function installDeferredPrompt(): {
  resolve: () => void;
  reject: (e: Error) => void;
  restore: () => void;
} {
  let resolveFn: (() => void) | null = null;
  let rejectFn: ((e: Error) => void) | null = null;
  const api = (globalThis as unknown as { window: { api: { btw: { prompt: (...a: unknown[]) => Promise<void> } } } }).window.api;
  const original = api.btw.prompt;
  api.btw.prompt = (...args: unknown[]): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      btwCalls.prompt.push(args);
      resolveFn = resolve;
      rejectFn = reject;
    });
  return {
    resolve: () => resolveFn?.(),
    reject: (e: Error) => rejectFn?.(e),
    restore: () => {
      api.btw.prompt = original;
    },
  };
}

// ---- 场景 16（P1）：close A → start B → A 的 prompt reject 晚到，禁止污染 B ----
async function scenarioLatePromptRejectIsolation(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  const deferredPrompt = installDeferredPrompt();
  useBtwStore.getState().send("A 问题");
  const btwIdA = useBtwStore.getState().btwId!;
  ok(btwCalls.prompt.length === 1, "16.1 A 的 prompt 已发出（挂起）");
  useBtwStore.getState().close();
  deferredPrompt.restore();
  useBtwStore.getState().start();
  const btwIdB = useBtwStore.getState().btwId!;
  ok(btwIdB !== btwIdA, "16.2 新会话 btwId 不同");
  // A 的 prompt 在 close/reopen 之后才 reject
  deferredPrompt.reject(new Error("BTW 会话不存在或已销毁"));
  await new Promise((r) => setTimeout(r, 0)); // flush 微任务
  const st = useBtwStore.getState();
  ok(st.active && st.btwId === btwIdB, "16.3 A 的 reject 不改变 B 的激活态");
  ok(st.error === null, "16.4 A 的 reject 不写入 B 的 error");
  ok(st.messages.length === 0, "16.5 A 的 reject 不写入 B 的 messages");
  ok(st.streaming === false, "16.6 A 的 reject 不改变 B 的 streaming");
  useBtwStore.getState().send("B 问题");
  ok(useBtwStore.getState().messages.length === 2, "16.7 B 仍可正常发送");
  ok(useBtwStore.getState().btwId === btwIdB, "16.8 B 身份未漂移");
}

// ---- 场景 17：同会话 prompt reject 仍正常写回 error（守卫/重试不误伤正常路径）----
async function scenarioSameSessionRejectStillWrites(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  await new Promise((r) => setTimeout(r, 0)); // start 完成 → ready
  ok(useBtwStore.getState().ready && !useBtwStore.getState().starting, "17.0 会话就绪");
  const deferredPrompt = installDeferredPrompt();
  useBtwStore.getState().send("A 问题");
  const btwIdA = useBtwStore.getState().btwId!;
  deferredPrompt.reject(new Error("仍在生成中"));
  await new Promise((r) => setTimeout(r, 0));
  ok(btwCalls.prompt.length === 2, "17.0b ready 后首次失败自动重试一次");
  deferredPrompt.reject(new Error("仍在生成中")); // 重试也失败 → settle
  await new Promise((r) => setTimeout(r, 0));
  const st = useBtwStore.getState();
  ok(st.active && st.btwId === btwIdA, "17.1 同会话 reject 后会话仍激活");
  ok((st.error ?? "").includes("仍在生成中"), "17.2 error 正常写回本会话");
  ok(st.streaming === false, "17.3 streaming 正常结束（无悬挂）");
  deferredPrompt.restore();
}

// ---- 场景 18（P2-1）：start 在途时发送 → 排队 → start 完成后自动补发（不丢输入、无需重发）----
async function scenarioSendWhileStartingQueuesAndReplays(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  const deferredStart = installDeferredStart();
  const deferredPrompt = installDeferredPrompt();
  useBtwStore.getState().start();
  ok(useBtwStore.getState().starting, "18.1 start 在途（starting）");
  useBtwStore.getState().send("首轮问题");
  const btwId = useBtwStore.getState().btwId!;
  const asstMsgId = useBtwStore.getState().messages[1]!.id;
  ok(btwCalls.prompt.length === 1, "18.2 首轮 prompt 已尝试");
  // 主进程会话尚未建成 → prompt 失败 → 排队（不显示 error、不丢消息）
  deferredPrompt.reject(new Error("BTW 会话不存在或已销毁"));
  await new Promise((r) => setTimeout(r, 0));
  let st = useBtwStore.getState();
  ok(st.pendingSend !== null, "18.3 排队等待 start 完成");
  ok(st.pendingSend!.text === "首轮问题" && st.pendingSend!.assistantMessageId === asstMsgId, "18.4 排队载荷与消息 id 一致");
  ok(st.error === null, "18.5 排队不显示错误（用户无感）");
  ok(st.streaming && st.messages.length === 2, "18.6 消息保留且 streaming 未中断");
  // start 完成 → 自动补发
  deferredStart.resolve();
  await new Promise((r) => setTimeout(r, 0));
  st = useBtwStore.getState();
  ok(st.ready && !st.starting && st.pendingSend?.userMessageId === st.messages[0]?.id, "18.7 start 完成、会话就绪、补发等待持久回执");
  ok(btwCalls.prompt.length === 2, "18.8 自动补发同一轮 prompt");
  ok(st.messages.length === 2 && st.messages[1]!.id === asstMsgId, "18.9 消息无重复、id 不变");
  ok(st.error === null, "18.10 全程无错误暴露");
  deferredStart.restore();
  deferredPrompt.restore();
}

// ---- 场景 19（P2-1）：start 失败 + 已排队首轮 → settle 消息，不卡 streaming ----
async function scenarioStartFailedSettlesQueuedTurn(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  const deferredStart = installDeferredStart();
  const deferredPrompt = installDeferredPrompt();
  useBtwStore.getState().start();
  useBtwStore.getState().send("首轮问题");
  const asstMsgId = useBtwStore.getState().messages[1]!.id;
  deferredPrompt.reject(new Error("BTW 会话不存在或已销毁"));
  await new Promise((r) => setTimeout(r, 0));
  deferredStart.reject(new Error("BTW 父任务不存在"));
  await new Promise((r) => setTimeout(r, 0));
  const st = useBtwStore.getState();
  ok(!st.starting && !st.ready && st.pendingSend === null, "19.1 启动失败终态");
  ok(st.streaming === false, "19.2 排队消息被 settle（不卡 streaming）");
  ok(st.messages[1]!.streaming === false, "19.3 助手消息 streaming 置 false");
  ok((st.error ?? "").includes("首轮未发送"), "19.4 错误明确说明首轮未发送");
  deferredStart.restore();
  deferredPrompt.restore();
}

// ---- 场景 20（P2-2）：带回幂等——同轮只带回一次，新一轮后可再次带回 ----
async function scenarioBringBackIdempotent(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q1");
  let { btwId, messages } = useBtwStore.getState();
  let asstId = messages[1]!.id;
  useBtwStore.getState().applyBtwPatch({ type: "text_delta", taskId: btwId!, btwId: btwId!, messageId: asstId, delta: "结论 1", final: true });
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asstId });
  useBtwStore.getState().bringBackToComposer();
  let draft = useAppStore.getState().composerDraft ?? "";
  ok((draft.match(/【BTW 结论】/g) ?? []).length === 1, "20.1 第一次带回写入一份结论");
  // 同一轮重复带回：拒绝，不重复追加
  useBtwStore.getState().bringBackToComposer();
  draft = useAppStore.getState().composerDraft ?? "";
  ok((draft.match(/【BTW 结论】/g) ?? []).length === 1, "20.2 重复带回不重复追加（幂等）");
  ok((useBtwStore.getState().notice ?? "").includes("已带回"), "20.3 给出已带回提示");
  // 新一轮完成后可再次带回
  useBtwStore.getState().send("Q2");
  ({ btwId, messages } = useBtwStore.getState());
  asstId = messages[3]!.id;
  useBtwStore.getState().applyBtwPatch({ type: "text_delta", taskId: btwId!, btwId: btwId!, messageId: asstId, delta: "结论 2", final: true });
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asstId });
  useBtwStore.getState().bringBackToComposer();
  draft = useAppStore.getState().composerDraft ?? "";
  ok((draft.match(/【BTW 结论】/g) ?? []).length === 2, "20.4 新一轮结论可再次带回");
  ok(draft.includes("结论 1") && draft.includes("结论 2"), "20.5 两轮结论都保留");
}

// ---- 场景 21（P2-5）：streaming 超时兜底——纯函数判定 + streamingSince 维护 ----
async function scenarioStreamingTimeoutPolicy(): Promise<void> {
  reset();
  const now = Date.now();
  ok(isStreamingStalled(true, now - BTW_STREAMING_TIMEOUT_MS - 1000, now) === true, "21.1 超时滞留判定");
  ok(isStreamingStalled(true, now - 60_000, now) === false, "21.2 未超时不判定");
  ok(isStreamingStalled(false, now - 999_999, now) === false, "21.3 非 streaming 不判定");
  ok(isStreamingStalled(true, null, now) === false, "21.4 无起点不判定");
  // streamingSince 维护：send 设置起点；assistant_end 清除
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q");
  const { btwId, messages, streamingSince } = useBtwStore.getState();
  ok(streamingSince !== null && streamingSince > 0, "21.5 send 后记录 streaming 起点");
  const asstId = messages[1]!.id;
  useBtwStore.getState().applyBtwPatch({ type: "assistant_end", taskId: btwId!, btwId: btwId!, messageId: asstId });
  ok(useBtwStore.getState().streamingSince === null, "21.6 终态后清除起点");
}

// ---- 场景 22（多窗口 id 碰撞回归）：连续 start/close 生成的 btwId 全局唯一 ----
async function scenarioBtwIdUniqueness(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  const seen = new Set<string>();
  const rounds = 20;
  for (let i = 0; i < rounds; i += 1) {
    useBtwStore.getState().start();
    const id = useBtwStore.getState().btwId!;
    ok(id.startsWith("btw-"), `22.${i + 1}.a 第 ${i + 1} 次 btwId 前缀`);
    // 格式 btw-<ts>-<counter>-<rand>：至少 4 段（含随机段，多窗口各自 counter 也不会碰撞）
    ok(id.split("-").length >= 4, `22.${i + 1}.b 第 ${i + 1} 次 btwId 含随机段`);
    seen.add(id);
    useBtwStore.getState().close();
    await new Promise((r) => setTimeout(r, 0));
  }
  ok(seen.size === rounds, "22.2 全部 btwId 无重复（多窗口同毫秒也不碰撞）");
}

// ---- 场景 23：回首页（activeTaskId=null）→ BTW 停止观察，不漂移 ----
async function scenarioDestroyOnHome(): Promise<void> {
  reset();
  useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  useBtwStore.getState().send("Q");
  ok(useBtwStore.getState().active, "23.1 BTW 已激活");
  // 模拟回到首页 / 删除当前任务（activeTaskId → null）
  useBtwStore.getState().destroyIfParentChanged(null);
  const st = useBtwStore.getState();
  ok(!st.active && st.messages.length === 0 && st.btwId === null, "23.2 回首页即清理观察界面");
  ok(btwCalls.close.length === 0 && btwCalls.abort.length === 0, "23.2b 回首页不取消执行");
  // 主任务消息不受影响
  ok(useAppStore.getState().tasks.find((t) => t.id === "t1")!.messages.length === 1, "23.3 Task.messages 未被污染");
}

async function scenarioDurableDeltaAndReattach(): Promise<void> {
  reset(); useAppStore.setState({ tasks: [mainTask], activeTaskId: "t1" });
  useBtwStore.getState().start();
  const btwId = useBtwStore.getState().btwId!;
  const first: DurableBotSnapshot = { backend: "pi-durable", epoch: "btw-epoch", revision: 1, conversationId: "1", toolMode: "native", busy: true,
    queued: 0, pendingInputs: [], compacting: false, messages: [{ id: "reply", role: "assistant", text: "1", createdAt: 1 }] };
  const next = (revision: number): DurableBotSnapshot => ({ ...first, revision, messages: [{ ...first.messages[0], text: String(revision) }] });
  const delta = (from: number, to: number) => {
    const full = next(to), { messages: _messages, epoch: _epoch, revision: _revision, ...state } = full;
    return durableDelta(next(from), full, state);
  };
  const apply = useBtwStore.getState().applyBtwPatch;
  apply({ type: "durable_snapshot", taskId: btwId, btwId, snapshot: first });
  apply({ type: "durable_delta", taskId: btwId, btwId, delta: delta(1, 2) });
  ok(useBtwStore.getState().durable?.revision === 2, "24.1 BTW 接收增量");
  const reads = btwCalls.start.length;
  apply({ type: "durable_delta", taskId: btwId, btwId, delta: delta(3, 4) });
  apply({ type: "durable_delta", taskId: btwId, btwId, delta: delta(4, 5) });
  ok(btwCalls.start.length === reads + 1, "24.2 revision缺失只发一次重附着请求");
  apply({ type: "durable_snapshot", taskId: btwId, btwId, snapshot: next(4) });
  ok(useBtwStore.getState().durable?.revision === 5, "24.3 全量重同步后补齐在途增量");
  useBtwStore.setState({ active: false, btwId: null, parentTaskId: null, startRequest: null, durable: undefined, messages: [] });
  useBtwStore.getState().destroyIfParentChanged("t1");
  ok(useBtwStore.getState().btwId === btwId, "24.4 renderer状态重建仍使用持久观察身份");
  useBtwStore.getState().close();
  ok(browserStorage.size === 0, "24.5 显式关闭才清除观察身份");
  await new Promise(resolve => setTimeout(resolve, 0));
}

void scenarioStartInFlightClose()
  .then(() => scenarioStaleStartRejected())
  .then(() => scenarioLatePromptRejectIsolation())
  .then(() => scenarioSameSessionRejectStillWrites())
  .then(() => scenarioSendWhileStartingQueuesAndReplays())
  .then(() => scenarioStartFailedSettlesQueuedTurn())
  .then(() => scenarioBringBackIdempotent())
  .then(() => scenarioStreamingTimeoutPolicy())
  .then(() => scenarioBtwIdUniqueness())
  .then(() => scenarioDestroyOnHome())
  .then(() => scenarioDurableDeltaAndReattach())
  .then(() => {
    console.log(`[btw-isolation-test] passed=${passed} failed=0`);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
