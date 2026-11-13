import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import { buildActivityRows, readWorkSummaryPrefix, useWorkSummaryPages } from "../src/renderer/src/lib/botActivityMonitor";
import type { WorkQueryRequest, WorkQueryResult } from "../src/shared/bot-work-query";
import { tasks, works, bots, histories } from "./bot-activity-fixtures";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const result = (ids: string[], sequence = 1): WorkQueryResult => ({ works: ids.map(id => ({ ...works[0], workId: id })), total: 3, filtered: 3, page: 1, pageSize: 2, pages: 2, filterCounts: {}, viewCounts: { all: 3, active: 3, completed: 0, closed: 0 }, deletedCount: 0, watermark: { epoch: "one", sequence, revision: "revision-" + sequence }, workExecutionTaskIds: ["binding-task"] });
async function main() {
  const request: WorkQueryRequest = { scope: { kind: "historical_teams" }, pageSize: 2 };
  const calls: number[] = [];
  const snapshots = [result(["a", "b"]), result(["b"], 2), result(["new", "a"], 2), result(["b"], 2)];
  const prefix = await readWorkSummaryPrefix(async value => { calls.push(value.page!); return snapshots.shift()!; }, request, 2);
  assert.deepEqual(calls, [1, 2, 1, 2]);
  assert.deepEqual(prefix?.works.map(work => work.workId), ["new", "a", "b"], "a changed page must replace the whole prefix");
  const revisionCalls: number[] = [];
  const revised = (ids: string[]) => ({ ...result(ids), watermark: { epoch: "one", sequence: 1, revision: "non-journal-change" } });
  const revisionSnapshots = [result(["a", "b"]), revised(["c"]), revised(["updated", "a"]), revised(["b"])];
  const revisionPrefix = await readWorkSummaryPrefix(async value => { revisionCalls.push(value.page!); return revisionSnapshots.shift()!; }, request, 2);
  assert.deepEqual(revisionCalls, [1, 2, 1, 2], "non-journal revision changes must restart the prefix even at the same stream sequence");
  assert.deepEqual(revisionPrefix?.works.map(work => work.workId), ["updated", "a", "b"]);
  const late = deferred<WorkQueryResult>(); let live = true;
  const abandoned = readWorkSummaryPrefix(() => late.promise, request, 2, () => live);
  live = false; late.resolve(result(["stale"]));
  assert.equal(await abandoned, null, "late response must not commit after scope switch");
  const summaryWork = { ...works[0], executions: [], listSummary: { status: { label: "执行中", group: "running" as const }, excerpt: "真实进度", deliverableCount: 2, canArchive: false, executionTaskIds: ["binding-task"], running: true } };
  const rows = buildActivityRows({ tasks, works: [summaryWork], bots, histories, subagents: {}, now: 200, scopeBotId: null });
  assert(!rows.some(row => row.id === "task:binding-task"));
  assert.equal(rows.find(row => row.workId === "work")?.running, true);
  assert.equal(rows.find(row => row.workId === "work")?.detail, "真实进度");
  const unloaded = buildActivityRows({ tasks, works: [], bots, histories, subagents: {}, now: 200, scopeBotId: null, workExecutionTaskIds: ["binding-task"] });
  assert(!unloaded.some(row => row.id === "task:binding-task"), "an unloaded Work is not an ordinary task");
  assert(unloaded.some(row => row.id === "task:ordinary"));
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending: Array<{ request: WorkQueryRequest; reply: ReturnType<typeof deferred<WorkQueryResult>> }> = [];
  Object.assign(window, { api: { botWork: { queryWorks: (value: WorkQueryRequest) => { const reply = deferred<WorkQueryResult>(); pending.push({ request: value, reply }); return reply.promise; } } } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  function Reader({ query, pages = 1 }: { query: string; pages?: number }) {
    const state = useWorkSummaryPages({ ...request, query }, pages);
    return <div>{state.result?.works.map(work => work.workId).join(",") ?? "loading"}</div>;
  }
  await act(async () => root.render(<Reader query="old" />));
  await act(async () => root.render(<Reader query="new" />));
  assert.equal(pending.length, 2, "new query need not wait for old request");
  await act(async () => pending[1].reply.resolve(result(["new"])));
  await act(async () => pending[0].reply.resolve(result(["old"])));
  assert.equal(document.getElementById("root")!.textContent, "new");
  await act(async () => root.render(<Reader query="new" pages={2} />));
  assert.equal(document.getElementById("root")!.textContent, "new", "keep loaded prefix while loading more");
  await act(async () => pending[2].reply.resolve(result(["a", "b"])));
  await act(async () => pending[3].reply.resolve(result(["c"])));
  assert.equal(document.getElementById("root")!.textContent, "a,b,c");
  await act(async () => root.unmount());
  const boundQueries: WorkQueryRequest[] = [];
  const candidates = Array.from({ length: 1001 }, (_, index) => "task-" + index);
  const bounded = await readWorkSummaryPrefix(async value => {
    boundQueries.push(value);
    return { ...result(["one"]), pages: 1, workExecutionTaskIds: value.candidateTaskIds ?? [] };
  }, { ...request, candidateTaskIds: candidates }, 1);
  assert.deepEqual(boundQueries.map(value => value.candidateTaskIds?.length), [500, 500, 1]);
  assert.deepEqual(bounded?.workExecutionTaskIds, candidates);
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  Object.assign(window.HTMLElement.prototype, { close() {}, showModal() {} });
  Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const { BotTeamsNavigation } = await import("../src/renderer/src/components/BotTeamsNavigation");
  const { useAppStore } = await import("../src/renderer/src/store/appStore");
  const historyWorks = Array.from({ length: 30 }, (_, index) => ({ ...works[0], workId: "history-" + index, title: "历史事项 " + index }));
  let selectedId = "";
  useAppStore.setState({ botWorks: works, botIdentities: [], activeTeam: null, setHistoricalTeamWork: work => { selectedId = work?.workId ?? ""; } });
  Object.assign(window, { api: { botWork: {
    teamControl: async () => ({ ok: true, templates: [] }),
    queryWorks: async (value: WorkQueryRequest) => {
      assert.equal(value.scope.kind, "historical_teams");
      const offset = ((value.page ?? 1) - 1) * 24;
      return { ...result([]), works: historyWorks.slice(offset, offset + 24), total: 30, filtered: 30, page: value.page ?? 1, pageSize: 24, pages: 2 };
    },
  } } });
  const sidebar = createRoot(document.getElementById("root")!);
  await act(async () => sidebar.render(<BotTeamsNavigation />));
  assert(document.body.textContent!.includes("Work 历史（30）"));
  assert(!document.body.textContent!.includes("临时团队"));
  assert(!document.body.textContent!.includes("历史事项 29"));
  const more = [...document.querySelectorAll("button")].find(button => button.textContent === "加载更多历史事项")!;
  await act(async () => more.dispatchEvent(new window.Event("click", { bubbles: true })));
  const oldWork = [...document.querySelectorAll("button")].find(button => button.textContent === "历史事项 29")!;
  assert(oldWork, "historical records beyond the initial 24 must be reachable");
  await act(async () => oldWork.dispatchEvent(new window.Event("click", { bubbles: true })));
  assert.equal(selectedId, "history-29");
  await act(async () => sidebar.unmount());
  console.log("PASS summary pagination: deferred query ownership, atomic prefix replacement, metadata and off-page task dedup");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
