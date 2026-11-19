import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Profiler } from "react";
import ChatView from "../src/renderer/src/components/chat/ChatView";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { durableDelta } from "../shared/src/durable-sync";
import type { DurableBotSnapshot } from "../src/shared/durable-bot";
import type { ChatMessageDto, TaskHistoryDto } from "../src/shared/agent-ipc";
import "../src/renderer/src/styles/global.css";

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const question = (task: string, n: number): ChatMessageDto => ({
  id: task + "-q" + n, createdAt: n, entryId: String(n), role: "user", text: task + " question " + n,
});
const initial = (id: string): DurableBotSnapshot => ({
  epoch: id + "-writer", revision: 1, historyId: id + "-history", backend: "pi-durable", conversationId: "1",
  busy: true, queued: 0, compacting: false, pendingInputs: [], toolMode: "native", historyBefore: 80,
  messages: [question(id, 81), { id: id + "-answer", role: "assistant", createdAt: 82, text: "", streaming: true }],
});

export async function verify() {
  const host = new Map(["A", "B"].map(id => [id, initial(id)]));
  const reads: string[] = [];
  const pages: string[] = [];
  const held: Array<{ id: string; resolve(history: TaskHistoryDto): void }> = [];
  let holdPages = false;
  const page = (id: string): TaskHistoryDto => ({
    messages: Array.from({ length: 80 }, (_, n) => question(id, n + 1)),
    page: { historyId: host.get(id)!.historyId },
  });
  Object.assign(window, { api: { agent: { async loadTaskHistory(id: string, before?: number) {
    if (before !== undefined) {
      pages.push(id);
      if (holdPages) return new Promise<TaskHistoryDto>(resolve => held.push({ id, resolve }));
      return page(id);
    }
    reads.push(id);
    const durable = host.get(id)!;
    return { durable, messages: durable.messages };
  } } } });
  const state = useAppStore.getState;
  const activate = (id: string) => flushSync(() => state().setActiveTask(id));
  const snapshot = (id: string) => state().applyAgentPatch({ type: "durable_snapshot", taskId: id, snapshot: host.get(id)! });
  const send = (fields: Partial<ChatMessageDto>, deliver = true) => {
    const prev = host.get("A")!;
    const next = { ...prev, revision: prev.revision + 1, messages: [prev.messages[0], { ...prev.messages[1], ...fields }] };
    host.set("A", next);
    const { epoch, messages, revision, ...metadata } = next;
    if (deliver) state().applyAgentPatch({ type: "durable_delta", taskId: "A", delta: durableDelta(prev, next, metadata) });
  };

  useAppStore.setState({ tasks: ["A", "B"].map(id => ({ id, title: id, welcomeMode: "general", messages: [], updatedAt: 1 })) });
  activate("A");
  const root = createRoot(document.getElementById("root")!);
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.message-scroll [id^="msg-"]'));
  const mixedCommits: string[] = [];
  const checkVisibleTask = () => {
    const active = state().activeTaskId;
    const wrong = rows().find(row => !row.id.startsWith("msg-" + active + "-"));
    if (wrong) mixedCommits.push(active + "/" + wrong.id);
  };
  flushSync(() => root.render(<Profiler id="chat" onRender={checkVisibleTask}><ChatView /></Profiler>));
  await frame();
  check(rows().length === 82 && pages.join() === "A", "opening should render all 82 rows and read only A: " + rows().length + "/" + pages);
  const timeline = document.querySelector<HTMLElement>(".message-scroll")!;
  timeline.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true }));
  const fullHeight = timeline.scrollHeight;
  for (const offset of [360, 900, 360, 0]) {
    timeline.scrollTop = offset;
    await frame();
    const ids = rows().map(row => row.id);
    check(ids.length === 82 && new Set(ids).size === 82 && timeline.scrollHeight === fullHeight,
      "scrolling duplicated rows or changed the length of the timeline");
  }
  check(pages.join() === "A", "scrolling reloaded an already complete archive");
  timeline.scrollTop = 180;
  await frame();
  const composer = document.querySelector("textarea")!;
  const inputY = composer.getBoundingClientRect().y;
  const top = timeline.scrollTop;
  check(top === 180, "fixture must have a scrollable timeline");
  const sameView = () => {
    check(timeline.isConnected && !document.body.textContent?.includes("正在加载历史对话"), "same task replaced its timeline with the loading page");
    check(document.querySelector("textarea") === composer && Math.abs(composer.getBoundingClientRect().y - inputY) <= 1, "composer moved");
    check(timeline.scrollTop === top && rows()[0]?.id === "msg-A-q1", "reading position or archive changed");
    check(new Set(rows().map(row => row.id)).size === 82 && rows().length === 82, "missing or duplicate rows");
  };
  const tool = { id: "lookup", tool: "read", summary: "fixture lookup", status: "running" as const };
  const initialReads = reads.length;
  for (const fields of [{ thinking: "consider" }, { thinking: "consider again" }, { tools: [tool] },
    { tools: [{ ...tool, status: "success" as const, output: "fixture result" }] }, { text: "reply" }, { text: "reply finished" }]) {
    if (fields.tools?.[0]?.status === "success") send({ thinking: "deliberately omitted revision" }, false);
    send(fields);
    await frame();
    sameView();
  }
  check(reads.length === initialReads + 1 && timeline.textContent?.includes("reply finished"), "one gap should recover and render later output");

  const resyncReads = reads.length - initialReads;
  holdPages = true;
  host.set("A", { ...host.get("A")!, epoch: "reopened", revision: 1 });
  snapshot("A");
  await frame();
  sameView();
  check(pages.join() === "A", "reopening the same durable history fetched the archive again");
  const jump = document.querySelector<HTMLButtonElement>('button[title="回到底部"]');
  check(jump, "return-to-bottom control missing");
  jump.click();
  await frame();
  const last = document.getElementById("msg-A-q81")!;
  check(Math.abs(last.getBoundingClientRect().top - timeline.getBoundingClientRect().top - timeline.clientTop - 8) <= 1, "last human question was not pinned");

  // Skip a whole live window across a reconnect. The old complete archive
  // remains mounted until the missing middle can be published in order.
  timeline.scrollTop = top;
  const original = host.get("A")!;
  host.set("A", { ...original, revision: 2, historyBefore: 89, messages: [question("A", 90)] });
  snapshot("A");
  await frame();
  sameView();
  check(held.length === 1, "missing middle was never requested");
  held.shift()!.resolve({ page: { historyId: original.historyId }, messages: [
    ...page("A").messages, ...original.messages, ...Array.from({ length: 7 }, (_, n) => question("A", n + 83)),
  ] });
  await frame();
  check(rows().length === 90 && rows()[89].id === "msg-A-q90", "reconnect silently omitted middle rows");
  check(timeline.isConnected && timeline.scrollTop === top, "publishing the recovered middle displaced the reader");
  activate("B");
  await frame();
  check(!rows().some(row => row.id.startsWith("msg-A-")) && held[0]?.id === "B", "B displayed A or failed to request its own archive");
  activate("A");
  await frame();
  check(held[1]?.id === "A", "A did not start its new display lifetime");
  activate("B");
  await frame();
  check(held[2]?.id === "B", "second B display did not start");
  held[2].resolve(page("B"));
  await frame();
  held[1].resolve(page("A"));
  held[0].resolve({ ...page("B"), messages: [question("obsolete", 1)] });
  await frame();
  check(rows().length === 82 && rows().every(row => row.id.startsWith("msg-B-")), "late A or obsolete B history replaced current B");
  check(!mixedCommits.length, "rendered another task's row during a switch: " + mixedCommits);
  root.unmount();
  return { rows: 82, resyncReads, pages, readingPosition: top, inputY };
}
