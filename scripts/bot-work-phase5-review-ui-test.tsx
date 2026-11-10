/** Real React lifecycle and button events with controlled API replies; not an IPC/browser acceptance test. */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import type { BotWorkApi } from "../src/shared/bot-work-ipc";
import type { WorkControlResult, WorkDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkCardReadResult, WorkExpandedDiagnosticsDto } from "../src/shared/bot-work-phase5";
import type { WorkReviewControlRequest } from "../src/shared/bot-work-review";
import type { WorkPhase3ControlRequest } from "../src/shared/bot-work-phase3-control";
import { WorkReviewPanel } from "../src/renderer/src/components/pages/BotWorkReviewPanel";
import { BotWorkDetails } from "../src/renderer/src/components/pages/BotWorkDetails";
import { WorkCardsPanel } from "../src/renderer/src/components/pages/BotWorkCardsPanel";
import BotWorkspacePage, { BotMessage } from "../src/renderer/src/components/pages/BotWorkspacePage";
import type { BotDto } from "../src/shared/bot-work";
import { useAppStore } from "../src/renderer/src/store/appStore";

const { window: testWindow, document: testDocument } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: testWindow, document: testDocument, HTMLElement: testWindow.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom has no layout engine, matchMedia or native dialog methods. Supply only
// those browser contracts here; actual modal focus/resize is verified in Electron.
Object.defineProperty(testWindow, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(testWindow.HTMLElement.prototype, {
  show() { this.setAttribute("open", ""); }, showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const work: WorkDto = {
  workId: "reviewed-work", userId: "local-user", ownerBotId: "owner", ownerEpoch: 3, participants: [],
  intentRevision: 2, sourceVersion: 1, title: "Review current output", constraints: [],
  criteria: [{ id: "criterion", text: "Check the current output", status: "pending", requiredIntentRevision: 2,
    requiresRealEnvironmentCheck: true, requiredEnvironment: "Windows", evidenceRefs: [] }],
  authorization: { allowedScopes: ["workspace:read"], targetWhitelist: [], allowRedelegation: false, allowGitBranchOrWorktree: false },
  activeIntentSnapshotId: "intent:2", inputSnapshotId: "input:2", goalSources: [], mode: "once", lifecycle: "active",
  acceptedDeliverableIds: ["accepted"], activeExecutionIds: [], deadlineRevision: 1, stateVersion: 7,
  createdBy: "user", createdAt: 1, updatedAt: 7,
};
const proposal: WorkProjectionDto["deliverables"][number] = {
  deliverableId: "proposal", workId: work.workId, producerBotId: "owner", executionId: "execution", intentRevision: 2,
  ownerEpoch: 3, inputSnapshotId: "input:2", status: "proposed", summary: "A proposal awaiting user review",
  artifactRefs: [], evidenceRefs: [], uncoveredScope: [], uncoveredCriterionIds: [], isSpeculation: false,
  hasWriteConflicts: false, createdAt: 6,
};
const projection: WorkProjectionDto = {
  ...work, inputSnapshotBound: true, deliverables: [proposal, { ...proposal, deliverableId: "accepted", status: "accepted" }],
  blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: [],
  cards: [{ cardKey: "card", semanticCardKey: "semantic-card", workId: work.workId, userId: work.userId,
    kind: "accepted_result", intentRevision: 2, inputSnapshotId: "input:2", originOwnerEpoch: 3,
    canonicalOutcomeHash: "outcome", title: "Retained result", summary: "One accepted result", deliverableIds: ["accepted"],
    evidenceIds: [], sourceRefs: [], artifactRefs: [], unverifiedScope: [], createdAt: 6, currency: "current",
    readVersion: 0, notificationIds: [] }],
  phase3: { subitems: [], continuations: [], gaps: [], settlingActions: 0,
    pausedEventCount: 0, artifactSnapshotId: "artifacts:7", handoffs: [], collaborationMessages: [] },
};
const success: WorkControlResult = { ok: true, replayed: false, operationId: "review-reply", work };
const readSuccess: WorkCardReadResult = { ok: true, cardKey: "card", semanticCardKey: "semantic-card", readAt: 10, readVersion: 1 };
let root: Root | undefined;
let container: HTMLElement;
let refreshes: boolean[] = [];
let reviewRequests: WorkReviewControlRequest[] = [];
let readRequests: Parameters<BotWorkApi["markCardRead"]>[0][] = [];
let reviewReply = deferred<WorkControlResult>();
let readReply = deferred<WorkCardReadResult>();
let diagnosticsReply = deferred<WorkExpandedDiagnosticsDto | undefined>();
let diagnosticsRequests = 0;
const api: Pick<BotWorkApi, "reviewControl" | "markCardRead" | "workDiagnostics"> = {
  reviewControl(request) { reviewRequests.push(request); return reviewReply.promise; },
  markCardRead(request) { readRequests.push(request); return readReply.promise; },
  workDiagnostics() { diagnosticsRequests += 1; return diagnosticsReply.promise; },
};
Object.defineProperty(testWindow, "api", { value: { botWork: api }, configurable: true });
const originalRefresh = useAppStore.getState().refreshBotWork;
useAppStore.setState({ refreshBotWork: async (includeClosed = false) => { refreshes.push(includeClosed); } });
type Panel = "review" | "cards";
const identity = (value: WorkProjectionDto) => JSON.stringify([value.workId, value.intentRevision,
  value.inputSnapshotId, value.ownerEpoch, value.stateVersion, value.phase3?.artifactSnapshotId]);
async function render(panel: Panel, includeClosed: boolean, value = projection) {
  await act(async () => {
    root!.render(<StrictMode>{panel === "review"
      ? <WorkReviewPanel key={value.workId} work={value} includeClosed={includeClosed} />
      : <WorkCardsPanel key={identity(value)} work={value} includeClosed={includeClosed} />}</StrictMode>);
  });
}
async function unmount() {
  if (root) { const previous = root; root = undefined; await act(async () => previous.unmount()); }
}
async function mount(panel: Panel, includeClosed = false, value = projection) {
  const { createRoot } = await import("react-dom/client");
  container = testDocument.body.appendChild(testDocument.createElement("div"));
  root = createRoot(container);
  await render(panel, includeClosed, value);
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === label);
  assert.ok(button, `expected an actual button labelled ${label}`);
  assert.equal(button.disabled, false, `${label} must be enabled before dispatch`);
  await act(async () => { button.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
}
async function change(label: string, value: string | boolean) {
  const field = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  assert.ok(field, `expected mounted field ${label}`);
  const key = Object.keys(field).find(key => key.startsWith("__reactProps$"))!;
  const props = (field as unknown as Record<string, { onChange: (event: { target: { value?: string; checked?: boolean } }) => void }>)[key];
  await act(async () => props.onChange({ target: typeof value === "boolean" ? { checked: value } : { value } }));
}
async function reset(panel: Panel) {
  await unmount(); testDocument.body.replaceChildren();
  refreshes = []; reviewRequests = []; readRequests = []; diagnosticsRequests = 0;
  reviewReply = deferred<WorkControlResult>(); readReply = deferred<WorkCardReadResult>();
  diagnosticsReply = deferred<WorkExpandedDiagnosticsDto | undefined>();
  await mount(panel);
}
async function begin(panel: Panel) {
  await click(panel === "review" ? "采纳成果" : "标记已读");
  assert.deepEqual(refreshes, [], "an unresolved operation must not refresh a speculative result");
  if (panel === "review") {
    assert.equal(reviewRequests.length, 1);
    const request = reviewRequests[0]!;
    assert.equal(request.kind, "accept_deliverable");
    assert.equal(request.request.workId, work.workId);
    assert.deepEqual(request.request.versionGuard, { expectedStateVersion: 7, expectedIntentRevision: 2, expectedOwnerEpoch: 3 });
    assert.ok(request.request.operationId.startsWith("desktop:review:"));
    if (request.kind === "accept_deliverable") assert.equal(request.request.deliverableId, proposal.deliverableId);
  } else assert.deepEqual(readRequests, [{ workId: work.workId, semanticCardKey: "semantic-card" }]);
}
async function complete(panel: Panel, failed = false) {
  await act(async () => {
    if (failed) (panel === "review" ? reviewReply : readReply).reject(new Error("late provider failure"));
    else if (panel === "review") reviewReply.resolve(success);
    else readReply.resolve(readSuccess);
  });
}
let count = 0;
async function check(name: string, run: () => Promise<void>) {
  if (process.env.BOT_WORK_UI_FILTER && !name.includes(process.env.BOT_WORK_UI_FILTER)) return;
  await run(); count += 1; console.log(`PASS ${count}: ${name}`);
}

async function main() {
  try {
    await check("automatic review: pending results and criteria never ask for acceptance or close clicks", async () => {
      await reset("review");
      assert.equal(container.querySelectorAll("button,input,textarea").length,0);
      assert.doesNotMatch(container.textContent!,/采纳成果|拒绝成果|确认结束/);
      await render("review",true,{...projection,stateVersion:projection.stateVersion+1});
      assert.equal(container.querySelectorAll("button").length,0);
    });
    await check("automatic review: only genuine information questions remain in the conversation", async () => {
      await reset("review");
      await render("review",false,{...projection,blockers:[{blockerId:"recipient",workId:projection.workId,kind:"operational",reason:"收件人是谁？",waitingForUserInput:true,status:"open",createdAt:1}]});
      assert.match(container.textContent!,/收件人是谁/);
      assert.match(container.textContent!,/直接在对话中回复/);
      assert.equal(container.querySelectorAll("button").length,0);
      await render("review",true,{...projection,lifecycle:"closed"});
      assert.equal(container.textContent,"");
    });
    for (const panel of ["cards"] as const) {
      await check(`${panel}: a deferred button action refreshes only the latest includeClosed scope`, async () => {
        await reset(panel); await begin(panel);
        await render(panel, true);
        await complete(panel);
        assert.deepEqual(refreshes, [true], "completion must not start a newer request for the captured old open scope");
        assert.match(container.textContent ?? "", /已标记为已读/);
      });
      for (const failed of [false, true]) await check(`${panel}: late ${failed ? "rejection" : "success"} after unmount cannot refresh or alter a new panel`, async () => {
        await reset(panel); await begin(panel);
        await unmount();
        await mount(panel, true, { ...projection, workId: "newly-selected-work", title: "New selection" });
        await complete(panel, failed);
        assert.deepEqual(refreshes, []);
        assert.doesNotMatch(container.textContent ?? "", /决定已保存|已标记为已读|late provider failure/);
        const button = [...container.querySelectorAll("button")].find(item => item.textContent === "标记已读");
        assert.equal(button?.disabled, false, "the new view is not controlled by the old action's busy state");
      });
    }
    await check("cards: a previous version's deferred diagnostics cannot populate the replacement card view", async () => {
      await reset("cards");
      await click("读取诊断");
      assert.equal(diagnosticsRequests, 1);
      const next = { ...projection, stateVersion: 8, phase3: { ...projection.phase3!, artifactSnapshotId: "artifacts:8" } };
      await render("cards", true, next);
      await act(async () => diagnosticsReply.reject(new Error("Old artifact diagnostics failed")));
      assert.doesNotMatch(container.textContent ?? "", /Old artifact diagnostics failed/);
      assert.deepEqual(refreshes, []);
      assert.equal([...container.querySelectorAll("button")].find(item => item.textContent === "读取诊断")?.disabled, false);
    });
    await check("workspace: a legacy blocker opens an owner reply draft without overwriting, sending or clearing", async () => {
      await unmount(); testDocument.body.replaceChildren();
      const originalState = useAppStore.getState(); const beforeReviews = reviewRequests.length; let sends = 0;
      const owner = { botId: "owner", displayName: "Owner", status: "active", authorization: work.authorization } as BotDto;
      const member = { botId: "member", displayName: "Member", status: "active", authorization: work.authorization } as BotDto;
      const legacy: WorkProjectionDto = { ...projection, team: undefined,
        blockers: [{ blockerId: "legacy-question", workId: work.workId, reason: "Please clarify the expected date", kind: "operational" as const,
          waitingForUserInput: true, status: "open" as const, createdAt: 1 }] };
      try {
        useAppStore.setState({ activeBotId: "owner", activeTeam: null, botIdentities: [owner, member], selectedWorkId: null,
          botWorks: [legacy], botDraft: "Owner unfinished draft", botDrafts: { member: "Member unfinished draft", owner: "Owner unfinished draft" },
          refreshBotHistory: async () => {}, refreshBotWork: async () => {}, submitBotDraft: async () => { sends += 1; } });
        const { createRoot } = await import("react-dom/client");
        container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
        await act(async () => root!.render(<StrictMode><BotWorkspacePage /></StrictMode>));
        const tabs = [...container.querySelectorAll<HTMLButtonElement>(".bot-view-tabs button")];
        assert.equal(tabs.length, 4);
        assert.deepEqual(tabs.map(tab => tab.querySelector("span")?.textContent), ["对话", "进行中", "已完成", "归档"]);
        assert.doesNotMatch(container.textContent!, /待你决定/);
        await act(async () => tabs[1].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        assert.match(container.querySelector(".bot-work-browser")!.textContent!, /Review current output/,
          "a task needing real input remains reachable in the active view");
        await act(async () => tabs[2].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        await act(async () => tabs[0].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        await act(async () => tabs[1].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        await act(async () => container.querySelector<HTMLButtonElement>(".bot-work-card")!.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        await click("向负责人回复此问题");
        const after = useAppStore.getState();
        assert.equal(after.activeBotId, "owner"); assert.equal(after.selectedWorkId, legacy.workId);
        assert.equal(after.botDrafts.member, "Member unfinished draft");
        assert.ok(after.botDraft.startsWith("Owner unfinished draft"));
        assert.match(after.botDraft, /legacy-question/); assert.match(after.botDraft, /Please clarify the expected date/);
        assert.equal(after.botWorks[0].blockers[0].status, "open"); assert.equal(sends, 0); assert.equal(reviewRequests.length, beforeReviews);
        const draft = after.botDraft;
        await click("向负责人回复此问题");
        assert.equal(useAppStore.getState().botDraft, draft, "repeat click does not append duplicate question text");
        await act(async () => useAppStore.setState({ botWorks: [{ ...legacy, stateVersion: 8 }] }));
        assert.equal(useAppStore.getState().botDraft, draft, "background refresh retains the reply draft");
      } finally { await unmount(); useAppStore.setState(originalState, true); }
    });
    await check("workspace: list excerpts are short prose and the same card opens the untouched complete report", async () => {
      await unmount(); testDocument.body.replaceChildren();
      const originalState = useAppStore.getState();
      const owner = { botId: "owner", displayName: "Owner", status: "active", authorization: work.authorization } as BotDto;
      const summary = "# Review current output\n\n总工期 **9 天**，关键路径 **A → C → D → E**。\n\n"
        + "证据已保存。".repeat(60) + "\n\n末尾原文：`/home/test/reports/schedule.json`，未做视觉验收。";
      const current = { ...projection, deliverables: [{ ...proposal, summary }] };
      const original = JSON.stringify(current);
      try {
        useAppStore.setState({ activeBotId: "owner", botIdentities: [owner], selectedWorkId: null, botWorks: [current],
          refreshBotHistory: async () => {}, refreshBotWork: async () => {} });
        const { createRoot } = await import("react-dom/client");
        container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
        await act(async () => root!.render(<StrictMode><BotWorkspacePage /></StrictMode>));
        const activeTab = container.querySelectorAll(".bot-view-tabs button")[1];
        await act(async () => activeTab.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        const card = container.querySelector<HTMLButtonElement>(".bot-work-card")!;
        const text = card.querySelector(".bot-work-excerpt")!.textContent!;
        assert.match(text, /^成果摘录：总工期 9 天，关键路径 A → C → D → E。/);
        assert.ok(Array.from(text).length <= 125);
        assert.doesNotMatch(text, /\*\*|#|\/home|末尾原文/);
        assert.match(card.textContent!, /查看完整内容/);
        await act(async () => card.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        assert.equal(useAppStore.getState().selectedWorkId, current.workId);
        assert.match(container.querySelector(".bot-work-details")!.textContent!, /末尾原文/);
        assert.match(container.querySelector(".bot-work-details")!.textContent!, /\/home\/test\/reports\/schedule.json/);
        assert.match(container.querySelector(".bot-work-details")!.textContent!, /未做视觉验收/);
        assert.equal(JSON.stringify(useAppStore.getState().botWorks[0]), original, "opening the excerpt changes no result/status/evidence");
      } finally { await unmount(); useAppStore.setState(originalState, true); }
    });
    await check("workspace: repeated state refreshes keep one inspector panel and both historical/current cards", async () => {
      await unmount(); testDocument.body.replaceChildren();
      const originalState = useAppStore.getState();
      const errors: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errors.push(args); originalError(...args); };
      const owner = { botId: "owner", displayName: "Owner", status: "active", authorization: work.authorization } as BotDto;
      let current: WorkProjectionDto = { ...projection, cards: [
        { ...projection.cards![0], cardKey: "history", semanticCardKey: "history", intentRevision: 1, currency: "historical" },
        projection.cards![0],
      ], phase4: { subscriptions: [], offlineGaps: [], causal: [], deadlineRevision: 1,
        host: { authorityId: "test", sessionId: "test", online: true, activeSince: 1 },
      } };
      try {
        useAppStore.setState({ activeBotId: "owner", botIdentities: [owner], selectedWorkId: current.workId,
          botWorks: [current], refreshBotHistory: async () => {}, refreshBotWork: async () => {},
          botHistories: { owner: { botId: "owner", conversationId: "conversation", revision: 1, archived: false,
            messages: [{ messageId: "stopped", botId: "owner", conversationId: "conversation", requestId: "request",
              ordinal: 1, role: "assistant", text: "", status: "cancelled", workIds: [], createdAt: 1, updatedAt: 2 }] } } });
        const { createRoot } = await import("react-dom/client");
        container = testDocument.body.appendChild(testDocument.createElement("div"));
        root = createRoot(container);
        await act(async () => root!.render(<StrictMode><BotWorkspacePage /></StrictMode>));
        const assertNoBudget = () => {
          assert.equal(container.querySelector('[aria-label="预算上限"]'), null);
          assert.doesNotMatch(container.textContent!, /共享预算|保存预算|预算核对|全团队 token/);
        };
        assertNoBudget();
        assert.match(container.querySelector('[data-message-id="stopped"]')!.textContent!, /已停止/);
        assert.doesNotMatch(container.querySelector('[data-message-id="stopped"]')!.textContent!, /处理中|正在回复|等待回复/);
        for (let version = 8; version <= 14; version++) {
          current = { ...current, stateVersion: version,
            cards: current.cards!.map(card => card.cardKey === "card" ? { ...card, summary: `Current result ${version}` } : card) };
          await act(async () => useAppStore.setState({ botWorks: [current] }));
          assert.equal(container.querySelectorAll('[aria-label="结果卡片与证据"]').length, 1);
          assert.equal(container.querySelectorAll('[aria-label="成果评审与结束"]').length, 0);
          assert.equal(container.querySelectorAll('[aria-label="结果卡片"]').length, 2, "distinct history is retained, not deduplicated away");
          assert.equal([...container.querySelectorAll("summary")].filter(item => item.textContent === "高级诊断与证据").length, 1);
          assert.equal([...container.querySelectorAll("h3")].filter(item => item.textContent === "外部通知").length, 0);
          assert.match(container.textContent!, new RegExp(`Current result ${version}`));
          if (version > 8) assert.doesNotMatch(container.textContent!, new RegExp(`Current result ${version - 1}`));
          assertNoBudget();
        }
        assert.equal(errors.filter(args => args.some(arg => String(arg).includes("same key"))).length, 0);
      } finally {
        await unmount(); useAppStore.setState(originalState, true); console.error = originalError;
      }
    });
    await check("terminal detail separates outcome from absent criteria and reuses readable reports", async () => {
      await unmount();
      const { createRoot } = await import("react-dom/client");
      container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
      const summary = '{"format":"bot-team-report-v1","conclusions":[]}';
      for (const [conclusion, label] of [["succeeded", "已完成"], ["cancelled", "已取消"], ["ended_unsuccessfully", "未完成"]] as const) {
        await act(async () => root!.render(<BotWorkDetails work={{ ...projection, lifecycle: "closed", closureConclusion: conclusion,
          criteria: [], closureSummary: summary, deliverables: [{ ...proposal, summary, presentation: {
            structured: { version: 1, conclusions: [{ text: "两份文件已保存", requestMessageId: "req", requestText: "整理文件", sources: [{ ref: "member", label: "资料员" }] }], observations: ["附加说明"] },
            teamFacts: [{ displayName: "核对员", responsibility: "核对文件", executionStatus: "failed", failureReason: "连接中断", sourceRefs: ["member"] }],
          } }], }} ownerName="Owner" includeClosed />));
        const progress = container.querySelector('[aria-label="目标与进度"]')!;
        assert.match(progress.textContent!, new RegExp(label));
        assert.match(progress.textContent!, /处理结论已返回对话/);
        assert.doesNotMatch(progress.textContent!, /暂不能确认完成进度/);
        assert.equal(progress.querySelector('details')!.hasAttribute('open'), false);
        const report = container.querySelector('.bot-result-report')!;
        assert.match(report.querySelector('.bot-result-body')!.textContent!, /两份文件已保存/);
        assert.doesNotMatch(report.querySelector('.bot-result-body')!.textContent!, /bot-team-report-v1/);
        assert.match(report.textContent!, /执行失败/);
        assert.match(report.textContent!, /连接中断/);
        assert.equal(report.querySelector('.bot-original-report')!.hasAttribute('open'), false);
      }
      await unmount();
    });
    await check("running files are visible without implying accepted output and open the exact registered path", async () => {
      await unmount();
      const { createRoot } = await import("react-dom/client");
      container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
      const opened: string[] = [];
      Object.assign(testWindow.api!, { openFolder: async (path: string) => { opened.push(path); } });
      await act(async () => root!.render(<BotWorkDetails work={{ ...projection, deliverables: [],
        runtimeObservations: [{ bindingId: "b", state: "recovering", reason: "宿主正在恢复原执行" }],
        generatedArtifacts: [{ bindingId: "b", path: "/fixture/result.html", digest: "a".repeat(64), sizeBytes: 31, registeredAt: 1, sourceEntryId: 12 }],
      }} ownerName="Owner" includeClosed />));
      assert.match(container.textContent!, /全部生成文件/);
      const generated = container.querySelector<HTMLDetailsElement>('details[aria-label="全部生成文件"]')!;
      assert.equal(generated.hasAttribute("open"), false);
      generated.setAttribute("open", "");
      assert.match(container.textContent!, /31 B/);
      assert.match(container.textContent!, /是否完成由助理结合原委托与实际结果判断/);
      assert.match(container.textContent!, /恢复中/);
      await click("打开文件");
      assert.deepEqual(opened, ["/fixture/result.html"]);
      await unmount();
    });
    await check("unknown effects remain visible as nonblocking evidence while real blockers remain actionable", async () => {
      await unmount();
      const { createRoot } = await import("react-dom/client");
      container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
      const base = { workId: projection.workId, waitingForUserInput: false, createdAt: 1 };
      await act(async () => root!.render(<BotWorkDetails work={{ ...projection, blockers: [
        { ...base, blockerId: "legacy-effect", kind: "external_effect", reason: "Lost legacy receipt", status: "open", unknownExternalEffectRef: "legacy-receipt" },
        { ...base, blockerId: "new-effect", kind: "operational", reason: "Timed-out process", status: "cleared", unknownExternalEffectRef: "process-receipt", details: { effectDisposition: "continue_without_replay" } },
        { ...base, blockerId: "actual-blocker", kind: "operational", reason: "Required permission is missing", status: "open" },
      ] }} ownerName="Owner" includeClosed onReplyToBlocker={() => {}} />));
      const diagnostics = container.querySelector('[aria-label="非阻塞执行记录"]');
      assert(diagnostics, "both old and normalized uncertain results have a visible diagnostic section");
      assert.match(diagnostics.textContent!, /Lost legacy receipt/);
      assert.match(diagnostics.textContent!, /Timed-out process/);
      assert.match(diagnostics.textContent!, /未知结果不会自动重放/);
      const blockers = container.querySelector('[aria-label="需要关注的阻碍"]');
      assert(blockers);
      assert.match(blockers.textContent!, /Required permission is missing/);
      assert.doesNotMatch(blockers.textContent!, /Lost legacy receipt|Timed-out process/);
      assert.equal(diagnostics.querySelector("button"), null, "uncertainty does not offer an unsafe replay or clear button");
      await unmount();
    });
    await check("result card keeps long text and scripts expandable and opens the exact saved attachment", async () => {
      await unmount();
      const { createRoot } = await import("react-dom/client");
      container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
      const opened: string[] = [], revealed: string[] = [];
      Object.assign(testWindow.api!, { openFolder: async (path: string) => { opened.push(path); }, showItemInFolder: async (path: string) => { revealed.push(path); } });
      const generated = [
        { bindingId: "b", path: "/fixture/report.csv", snapshotPath: "/snap/hash-csv", digest: "csv", sizeBytes: 42, registeredAt: 1, sourceEntryId: 1 },
        { bindingId: "b", path: "/fixture/create.py", snapshotPath: "/snap/hash-py", digest: "py", sizeBytes: 100, registeredAt: 1, sourceEntryId: 2 },
      ];
      await act(async () => root!.render(<BotMessage botName="MyBuddy" works={[{ ...projection, intentRevision: projection.intentRevision + 1, generatedArtifacts: [], historicalGeneratedArtifacts: generated }]}
        onOpenWork={() => {}} onCancel={() => {}} message={{ messageId: "result-long", conversationId: "chat", botId: "owner", requestId: "r", ordinal: 1,
          role: "assistant", status: "completed", text: "完整原文与原始引用", workIds: [projection.workId], createdAt: 1, updatedAt: 1,
          workFeedback: { workId: projection.workId, eventId: "result:b", kind: "result", category: "result", executionId: "b", report: {
            title: "六任务中的 CSV 报告", summary: "报告结论\n\n" + "完整内容。".repeat(350), artifactRefs: ["/snap/hash-py", "/snap/hash-csv"],
            reviewStatus: "proposed", current: false, notices: ["尚未覆盖：实机验收"],
          } },
        }} />));
      assert(container.querySelector(".bot-result-body.is-collapsed"));
      await click("展开完整报告");
      assert.equal(container.querySelector(".bot-result-body.is-collapsed"), null);
      await click("收起长报告");
      assert(container.querySelector(".bot-result-body.is-collapsed"));
      const scripts = container.querySelector<HTMLDetailsElement>(".bot-result-other-files")!;
      assert.equal(scripts.hasAttribute("open"), false, "scripts stay accessible without competing with the report");
      const files = [...container.querySelectorAll<HTMLLIElement>(".bot-result-files > li")];
      assert(files[0].textContent!.includes("report.csv"));
      const openReport = [...files[0].querySelectorAll("button")].find(button => button.textContent === "打开保存版本")!;
      await act(async () => { openReport.click(); });
      assert.deepEqual(opened, ["/snap/hash-csv"]);
      files[0].querySelector("details")!.setAttribute("open", "");
      await act(async () => { [...files[0].querySelectorAll("button")].find(button => button.textContent === "定位文件")!.click(); });
      assert.deepEqual(revealed, ["/fixture/report.csv"]);
      const original = container.querySelector<HTMLDetailsElement>(".bot-original-report")!;
      assert.equal(original.hasAttribute("open"), false);
      original.setAttribute("open", "");
      assert.match(original.textContent!, /完整原文与原始引用/);
      await unmount();
    });
    await check("retired isolation and approval surfaces render nothing in Work details", async () => {
      await unmount();
      const { createRoot } = await import("react-dom/client");
      container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
      await act(async () => root!.render(<BotWorkDetails work={{ ...projection, phase3: { ...projection.phase3!, settlingActions: 1 } }}
        ownerName="Owner" includeClosed onReplyToBlocker={() => {}} />));
      assert.match(container.textContent!, /仍有 1 项在途操作等待结算/);
      assert.doesNotMatch(container.textContent!, /共享资源|后台操作审批|授权规则|重新核对隔离资源|原操作效果核对/);
      await act(async () => root!.render(<BotWorkDetails work={{ ...projection, blockers: [
        { blockerId: "continuation:old", workId: projection.workId, kind: "operational", reason: "Old execution gap",
          waitingForUserInput: true, status: "open", createdAt: 1 },
        { blockerId: "recovery-ended:gap", workId: projection.workId, kind: "operational", reason: "Recovery ended without a new result",
          waitingForUserInput: false, status: "open", createdAt: 1 },
      ] }} ownerName="Owner" includeClosed onReplyToBlocker={() => {}} />));
      assert.doesNotMatch(container.textContent!, /向负责人回复此问题/,
        "operational recovery gaps do not ask the user to fill information or approve a rerun");
      assert.match(container.textContent!, /Recovery ended without a new result/, "remaining execution gaps are still visible");
    });
    console.log(`Bot Work review UI: ${count} React lifecycle scenarios passed (controlled API promises, no real IPC/browser claim)`);
  } finally {
    await unmount(); useAppStore.setState({ refreshBotWork: originalRefresh });
    testDocument.body.replaceChildren();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
