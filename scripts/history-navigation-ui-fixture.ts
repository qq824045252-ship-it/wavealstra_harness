import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement, createRef } from "react";
import type { Task } from "../src/renderer/src/types";
import type { TaskHistoryDto, TaskHistoryTarget, TaskUserQuestionsDto, TaskUserQuestionsQuery } from "../src/shared/agent-ipc";
import { useHistoryQuestions } from "../src/renderer/src/components/chat/useHistoryQuestions";
import { useEarlierHistory } from "../src/renderer/src/components/chat/useEarlierHistory";
import { useAppStore } from "../src/renderer/src/store/appStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function verifyHistoryUi() {
  const { window, document } = parseHTML("<html><body><div id='root'></div><div id='scroll'></div></body></html>");
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  const pending: Array<{ taskId: string; query?: TaskUserQuestionsQuery; reply: ReturnType<typeof deferred<TaskUserQuestionsDto>> }> = [];
  const history: Array<{ taskId: string; target?: TaskHistoryTarget; reply: ReturnType<typeof deferred<TaskHistoryDto>> }> = [];
  Object.assign(window, { api: { agent: {
    listTaskUserQuestions: (taskId: string, query?: TaskUserQuestionsQuery) => {
      const reply = deferred<TaskUserQuestionsDto>(); pending.push({ taskId, query, reply }); return reply.promise;
    },
    loadTaskHistory: (taskId: string, target?: TaskHistoryTarget) => {
      const reply = deferred<TaskHistoryDto>(); history.push({ taskId, target, reply }); return reply.promise;
    },
  } } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  let questions: ReturnType<typeof useHistoryQuestions> | undefined;
  const reader = () => { assert(questions); return questions; };
  function Questions({ taskId, historyId }: { taskId: string; historyId: string }) {
    questions = useHistoryQuestions(taskId, historyId);
    return createElement("div", null, questions.index?.map(item => item.text).join(","));
  }
  await act(async () => root.render(createElement(Questions, { taskId: "A", historyId: "branch-A" })));
  await act(async () => pending[0].reply.resolve({ historyId: "branch-A", questions: [{ id: "3", text: "third" }], nextBefore: 2 }));
  assert.equal(reader().hasMore, true);
  await act(async () => { reader().loadMore(); reader().loadMore(); });
  assert.equal(pending.length, 2, "double clicks issue one continuation");
  assert.deepEqual(pending[1].query, { beforeEntryId: 2, historyId: "branch-A" });
  await act(async () => pending[1].reply.resolve({ historyId: "branch-A", questions: [], nextBefore: 1 }));
  assert.equal(reader().hasMore, true, "a hidden-only page still has a continuation");
  await act(async () => reader().loadMore());
  await act(async () => pending[2].reply.reject(new Error("retry me")));
  assert.equal(reader().error, "retry me");
  assert.equal(reader().index?.[0].text, "third");
  await act(async () => reader().loadMore());
  await act(async () => root.render(createElement(Questions, { taskId: "B", historyId: "branch-B" })));
  await act(async () => pending[4].reply.resolve({ historyId: "branch-B", questions: [{ id: "b", text: "B" }] }));
  await act(async () => pending[3].reply.resolve({ historyId: "branch-A", questions: [{ id: "a", text: "late A" }] }));
  assert.deepEqual(reader().index, [{ id: "b", text: "B" }]);
  assert.equal(reader().hasMore, false);

  const scrollRef = createRef<HTMLDivElement>();
  const scroll = document.querySelector<HTMLDivElement>("#scroll");
  assert(scroll);
  scrollRef.current = scroll;
  scrollRef.current.scrollTop = 0;
  const task = (id: string): Task => ({ id, title: id, updatedAt: 0, status: "completed", messages: [],
    durable: { backend: "pi-durable", epoch: "live-runtime", historyId: "persistent-branch", revision: 1,
      conversationId: "1", toolMode: "native", busy: false, queued: 0, pendingInputs: [], compacting: false, messages: [], historyBefore: 400 } });
  const a = task("A");
  useAppStore.setState({ activeTaskId: "A", tasks: [a, task("B")] });
  let earlier: ReturnType<typeof useEarlierHistory> | undefined;
  const controller = () => { assert(earlier); return earlier; };
  function Earlier({ taskId = "A" }: { taskId?: string }) {
    const row = useAppStore(state => state.tasks.find(item => item.id === taskId));
    earlier = useEarlierHistory({ taskId, cursor: row?.historyWindow?.before ?? row?.durable?.historyBefore,
      scrollRef, applyProgrammaticScrollTop: () => {} });
    return null;
  }
  await act(async () => root.render(createElement(Earlier)));
  await act(async () => { controller().requestEarlier(); controller().requestEarlier(); });
  assert.equal(history.length, 1, "only one earlier page can be in flight");
  assert.equal(history[0].target, 400);
  await act(async () => history[0].reply.resolve({ messages: [{ id: "durable-390", role: "user", text: "old question", createdAt: 390 }],
    page: { historyId: "persistent-branch", before: 350 } }));
  assert.equal(useAppStore.getState().tasks[0].historyWindow?.before, 350, "page from an independent runtime is accepted");
  assert.equal(useAppStore.getState().tasks[0].historyWindow?.messages[0].id, "durable-390");
  let jump: Promise<boolean> | undefined;
  await act(async () => { jump = controller().loadAround(1); });
  assert.deepEqual(history[1].target, { aroundEntryId: 1 });
  await act(async () => history[1].reply.resolve({ messages: [{ id: "durable-1", role: "user", text: "first question", createdAt: 1 }],
    page: { historyId: "persistent-branch", after: 25 } }));
  assert.equal(await jump, true);
  assert.equal(useAppStore.getState().tasks[0].historyWindow?.kind, "focus");
  assert.deepEqual(useAppStore.getState().tasks[0].historyWindow?.messages.map(item => item.id), ["durable-1"], "jump keeps a separate bounded window");
  let newer: Promise<void> | undefined;
  await act(async () => { newer = controller().loadNewer(); });
  assert.deepEqual(history[2].target, { afterEntryId: 25 });
  await act(async () => history[2].reply.resolve({ messages: [{ id: "durable-26", role: "assistant", text: "next", createdAt: 26 }], page: { historyId: "persistent-branch" } }));
  await newer;
  assert.deepEqual(useAppStore.getState().tasks[0].historyWindow?.messages.map(item => item.id), ["durable-1", "durable-26"]);
  const selectedWindow = useAppStore.getState().tasks[0].historyWindow;
  await act(async () => { jump = controller().loadAround(20); controller().cancelPending(); });
  await act(async () => history.at(-1)!.reply.reject(new Error("stale failed selection")));
  assert.equal(await jump, false, "selecting an already visible question cancels the earlier positioning request");
  assert.equal(useAppStore.getState().tasks[0].historyWindow, selectedWindow);
  await act(async () => { jump = controller().loadAround(2); controller().clearWindow(); });
  await act(async () => history.at(-1)!.reply.resolve({ messages: [], historyError: "stale history failure" }));
  assert.equal(await jump, false);
  assert.equal(useAppStore.getState().tasks[0].historyWindow, undefined);
  await act(async () => { jump = controller().loadAround(3); });
  await act(async () => { useAppStore.setState({ activeTaskId: "B" }); root.render(createElement(Earlier, { taskId: "B" })); });
  await act(async () => history.at(-1)!.reply.resolve({ messages: [], page: { historyId: "persistent-branch" } }));
  assert.equal(await jump, false, "task switch invalidates pending positioning");
  await act(async () => { jump = controller().loadAround(4); });
  await act(async () => history.at(-1)!.reply.resolve({ messages: [], page: { historyId: "regenerated-branch" } }));
  assert.equal(await jump, false, "branch changes reject even matching numeric entry IDs");
  await act(async () => { jump = controller().loadAround(5); });
  await act(async () => { useAppStore.setState(state => ({ tasks: state.tasks.map(task => task.id === "B" && task.durable
    ? { ...task, durable: { ...task.durable, epoch: "reopened-runtime" } } : task) })); });
  await act(async () => history.at(-1)!.reply.resolve({ messages: [], page: { historyId: "persistent-branch" } }));
  assert.equal(await jump, false, "an in-flight response cannot cross a live runtime replacement");
  await act(async () => root.unmount());
  console.log("PASS real React history hooks: resumable questions, retry, independent epochs, bounded positioning, forward reading and late-response fences");
}
