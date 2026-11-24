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

async function waitFor(ready: () => boolean, reason: string | (() => string)): Promise<void> {
  for (let count = 0; count < 40; count++) {
    if (ready()) return;
    await frame();
  }
  check(ready(), typeof reason === "function" ? reason() : reason);
}

const question = (task: string, n: number): ChatMessageDto => ({
  id: task + "-q" + n, createdAt: n, entryId: String(n), role: "user", text: task + " question " + n,
});
const questions = (task: string, start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, index) => question(task, start + index));
const initial = (id: string): DurableBotSnapshot => ({
  epoch: id + "-writer", revision: 1, historyId: id + "-history", backend: "pi-durable", conversationId: "1",
  busy: true, queued: 0, compacting: false, pendingInputs: [], toolMode: "native", historyBefore: id === "A" ? 235 : 260,
  messages: [...questions(id, id === "A" ? 236 : 261, 359), { id: id + "-answer", role: "assistant", createdAt: 360, entryId: "360", text: "", streaming: true }],
});

export async function verify() {
  const host = new Map(["A", "B"].map(id => [id, initial(id)]));
  const reads: string[] = [];
  const held: Array<{ id: string; before: number; resolve(history: TaskHistoryDto): void }> = [];
  const page = (id: string, before: number): TaskHistoryDto => ({
    messages: questions(id, Math.max(1, before - 49), before),
    page: { historyId: host.get(id)!.historyId, before: before > 50 ? before - 50 : undefined },
  });
  Object.assign(window, { api: { agent: { async loadTaskHistory(id: string, before?: number) {
    if (before !== undefined) {
      return new Promise<TaskHistoryDto>(resolve => held.push({ id, before, resolve }));
    }
    reads.push(id);
    const durable = host.get(id)!;
    return { durable, messages: durable.messages };
  }, async listTaskUserQuestions(id: string) {
    return { historyId: host.get(id)!.historyId, questions: [{ id: id + "-q200", text: id + " question 200" }] };
  } } } });
  const state = useAppStore.getState;
  const activate = (id: string) => flushSync(() => state().setActiveTask(id));
  const snapshot = (id: string) => state().applyAgentPatch({ type: "durable_snapshot", taskId: id, snapshot: host.get(id)! });
  const send = (fields: Partial<ChatMessageDto>, deliver = true) => {
    const prev = host.get("A")!;
    const next = { ...prev, revision: prev.revision + 1, messages: [...prev.messages.slice(0, -1), { ...prev.messages.at(-1)!, ...fields }] };
    host.set("A", next);
    const { epoch, messages, revision, ...metadata } = next;
    if (deliver) state().applyAgentPatch({ type: "durable_delta", taskId: "A", delta: durableDelta(prev, next, metadata) });
  };

  useAppStore.setState({ tasks: ["A", "B"].map(id => ({ id, title: id, welcomeMode: "general", messages: [], updatedAt: 1 })) });
  activate("A");
  const root = createRoot(document.getElementById("root")!);
  const viewport = () => document.querySelector<HTMLElement>(".message-scroll")!;
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.message-scroll [id^="msg-"]'));
  const shown = (task: string, n: number) => document.getElementById("msg-" + task + "-q" + n);
  const mixedCommits: string[] = [];
  const checkVisibleTask = () => {
    const active = state().activeTaskId;
    const wrong = rows().find(row => !row.id.startsWith("msg-" + active + "-"));
    if (wrong) mixedCommits.push(active + "/" + wrong.id);
  };

  const wheelUp = () => viewport().dispatchEvent(new WheelEvent("wheel", { deltaY: -800, bubbles: true }));
  const nearTop = (position = 18): void => {
    wheelUp();
    viewport().scrollTop = position;
  };
  const askForEarlier = async () => {
    nearTop();
    await frame();
    if (viewport().scrollTop < 40) wheelUp();
  };
  const scrollDetails = () => JSON.stringify({
    top: viewport()?.scrollTop,
    height: viewport()?.scrollHeight,
    window: rows().map(row => [row.id, row.getAttribute("aria-setsize")]),
    requests: held.map(request => [request.id, request.before]),
  });
  const rowOffset = (row: HTMLElement) => row.getBoundingClientRect().top - viewport().getBoundingClientRect().top;
  const visibleRow = () => rows().find(row => {
    const viewportBounds = viewport().getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return bounds.bottom > viewportBounds.top + 1 && bounds.top < viewportBounds.bottom;
  });
  const checkWindowSize = () => {
    const ids = rows().map(row => row.id);
    check(ids.length > 0 && ids.length < 40 && new Set(ids).size === ids.length,
      "visible transcript must remain bounded and free of duplicate messages: " + ids.length);
  };

  flushSync(() => root.render(<Profiler id="chat" onRender={checkVisibleTask}><ChatView /></Profiler>));
  await waitFor(() => {
    const row = shown("A", 359);
    return row !== null && Math.abs(rowOffset(row) - 8) <= 2;
  }, () => "latest question should be visibly pinned on opening: " + scrollDetails()
    + "; last offset " + (shown("A", 359) && rowOffset(shown("A", 359)!)));
  await frame();
  check(shown("A", 359)?.getAttribute("aria-setsize") === "100", "opening did not expose exactly the latest 100 messages");
  check(!shown("A", 261) && held.length === 0, "opening eagerly mounted or fetched old history");
  checkWindowSize();
  const timeline = viewport();
  const composer = document.querySelector("textarea")!;
  const inputY = composer.getBoundingClientRect().y;

  await askForEarlier();
  await waitFor(() => rows()[0]?.getAttribute("aria-setsize") === "125",
    () => "scrolling did not reveal the existing earlier rows: " + scrollDetails());
  check(shown("A", 261), "revealing the earlier rows displaced the current reading anchor: " + scrollDetails());
  check(held.length === 0, "scrolling requested a server page before revealing locally available messages");

  await frame();
  await askForEarlier();
  await waitFor(() => held.length === 1 && Boolean(shown("A", 236)),
    () => "scrolling to the first page did not request earlier messages: " + scrollDetails());
  check(held[0].before === 235, "the page must continue before the earlier rows already available");
  check(!shown("A", 235), "older history appeared before the page was delivered");
  check(!Array.from(timeline.querySelectorAll("button")).some(button =>
    /加载更多|加载历史|更早历史/.test(button.textContent ?? "")), "automatic loading added a pagination button");
  timeline.scrollTop = 31;
  await frame();
  const originalAnchor = visibleRow();
  check(originalAnchor?.id === "msg-A-q236", "expected the first loaded question to be the reading anchor");
  const beforePrepend = rowOffset(originalAnchor);
  const pendingPage = held.shift()!;
  pendingPage.resolve(page(pendingPage.id, pendingPage.before));
  await waitFor(() => Boolean(shown("A", 235)), "scrolling did not expose the preceding page");
  await frame();
  const anchorAfter = shown("A", 236);
  check(anchorAfter && Math.abs(rowOffset(anchorAfter) - beforePrepend) <= 2, "prepended history moved the question being read");
  checkWindowSize();

  const readingOffset = rowOffset(anchorAfter);
  const sameView = () => {
    check(timeline.isConnected && !document.body.textContent?.includes("正在加载历史对话"), "same task replaced its timeline with the loading page");
    check(document.querySelector("textarea") === composer && Math.abs(composer.getBoundingClientRect().y - inputY) <= 1, "composer moved");
    const row = shown("A", 236);
    check(row && Math.abs(rowOffset(row) - readingOffset) <= 2, "reading position changed");
    checkWindowSize();
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
  check(reads.length === initialReads + 1, "one gap should recover from one current snapshot");
  const resyncReads = reads.length - initialReads;
  host.set("A", { ...host.get("A")!, epoch: "reopened", revision: 1 });
  snapshot("A");
  await frame();
  sameView();
  check(!held.length, "reopening the same durable history fetched older history again");
  const jump = () => document.querySelector<HTMLButtonElement>('button[title="回到底部"]');
  check(jump(), "return-to-bottom control missing");
  jump()!.click();
  await waitFor(() => timeline.textContent?.includes("reply finished") === true, "latest reply after resync was not reachable");
  await waitFor(() => {
    const last = shown("A", 359);
    return last !== null && Math.abs(rowOffset(last) - timeline.clientTop - 8) <= 2;
  }, () => "last human question was not pinned: " + scrollDetails()
    + "; last offset " + (shown("A", 359) && rowOffset(shown("A", 359)!)));

  const chooseHistoryQuestion = async (n: number): Promise<void> => {
    check(!shown("A", n), "old question should be outside the mounted message range");
    document.querySelector<HTMLButtonElement>('button[title="历史提问"]')!.click();
    const oldQuestion = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".history-popup-item"))
      .find(button => button.textContent === "A question " + n);
    await waitFor(() => Boolean(oldQuestion()), "history picker omitted an offscreen loaded question");
    oldQuestion()!.click();
    await waitFor(() => {
      const row = shown("A", n);
      return row !== null && Math.abs(rowOffset(row) - 8) <= 2;
    }, () => "history picker did not place question " + n + " at the top: " + scrollDetails()
      + "; selected offset " + (shown("A", n) && rowOffset(shown("A", n)!)));
    await frame();
  };

  // Reconnecting with a live window moved beyond the old tail fills only the gap.
  await chooseHistoryQuestion(236);
  const previousOffset = rowOffset(shown("A", 236)!);
  const original = host.get("A")!;
  host.set("A", { ...original, revision: 2, historyBefore: 368, messages: [question("A", 369), question("A", 370), question("A", 371)] });
  snapshot("A");
  await waitFor(() => held.some(request => request.before === 368), "missing middle was never requested");
  check(timeline.isConnected && Math.abs(rowOffset(shown("A", 236)!) - previousOffset) <= 2, "the reconnect displaced the reader before recovery");
  held.shift()!.resolve({
    page: { historyId: original.historyId, before: 358 },
    messages: [...original.messages.slice(-2), ...questions("A", 361, 368)],
  });
  await frame();
  check(!held.length, "reconnect read past the gap into existing history");
  check(timeline.isConnected && Math.abs(rowOffset(shown("A", 236)!) - previousOffset) <= 2, "publishing the recovered middle displaced the reader");
  check(jump(), "return-to-bottom control missing after reconnect");
  jump()!.click();
  await waitFor(() => Boolean(shown("A", 368) && shown("A", 371)), "reconnect omitted the recovered middle or the new tail");

  await chooseHistoryQuestion(200);

  // In-flight pages belong to their activation, even when returning to the same task ID.
  await askForEarlier();
  await waitFor(() => held.some(request => request.id === "A"),
    () => "A did not request its remaining earlier history: " + scrollDetails());
  activate("B");
  await waitFor(() => {
    const row = shown("B", 359);
    return row !== null && Math.abs(rowOffset(row) - 8) <= 2;
  }, "B did not visibly pin its latest history");
  await frame();
  await askForEarlier();
  const bRequests = () => held.filter(request => request.id === "B");
  await waitFor(() => bRequests().length === 1, () => "B did not issue its own earlier page request: " + scrollDetails());
  activate("A");
  await frame();
  activate("B");
  await waitFor(() => visibleRow()?.id === "msg-B-q261", "B's second activation did not restore its reading position");
  await frame();
  viewport().scrollTop = 640;
  await frame();
  await askForEarlier();
  await waitFor(() => bRequests().length === 2, () => "B's second activation did not start a new request: " + scrollDetails());
  const [obsoleteB, currentB] = bRequests();
  currentB.resolve(page("B", currentB.before));
  await waitFor(() => Boolean(shown("B", 260)), "B's current page was not applied");
  for (const request of held.filter(request => request.id === "A")) request.resolve(page("A", request.before));
  obsoleteB.resolve({ ...page("B", obsoleteB.before), messages: [question("obsolete", 1)] });
  await frame();
  check(shown("B", 260) && rows().every(row => row.id.startsWith("msg-B-")), "late A or obsolete B history replaced current B");
  check(!mixedCommits.length, "rendered another task's row during a switch: " + mixedCommits);
  checkWindowSize();
  root.unmount();
  return { resyncReads, preservedAnchor: originalAnchor.id, inputY };
}
