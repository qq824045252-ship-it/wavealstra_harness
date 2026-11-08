/** Real React lifecycle and button events with controlled API replies; not an IPC/browser acceptance test. */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import type { BotWorkApi } from "../src/shared/bot-work-ipc";
import type { WorkControlResult, WorkDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkCardReadResult, WorkExpandedDiagnosticsDto } from "../src/shared/bot-work-phase5";
import type { WorkReviewControlRequest } from "../src/shared/bot-work-review";
import { WorkReviewPanel } from "../src/renderer/src/components/pages/BotWorkReviewPanel";
import { WorkCardsPanel } from "../src/renderer/src/components/pages/BotWorkCardsPanel";
import BotWorkspacePage from "../src/renderer/src/components/pages/BotWorkspacePage";
import type { BotDto } from "../src/shared/bot-work";
import { useAppStore } from "../src/renderer/src/store/appStore";

const { window: testWindow, document: testDocument } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: testWindow, document: testDocument, IS_REACT_ACT_ENVIRONMENT: true });
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
  budget: { windowId: "budget", maxTokens: 100, usedTokens: 0, reservedTokens: 0, unknownUsageCount: 0,
    windowStartAt: 1, allowNextWindow: false }, createdBy: "user", createdAt: 1, updatedAt: 7,
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
  phase3: { subitems: [], continuations: [], gaps: [], resourceWaits: [], resourceRecoveries: [], settlingActions: 0,
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
      ? <WorkReviewPanel key={identity(value)} work={value} includeClosed={includeClosed} />
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
  await run(); count += 1; console.log(`PASS ${count}: ${name}`);
}

async function main() {
  try {
    for (const panel of ["review", "cards"] as const) {
      await check(`${panel}: a deferred button action refreshes only the latest includeClosed scope`, async () => {
        await reset(panel); await begin(panel);
        await render(panel, true);
        await complete(panel);
        assert.deepEqual(refreshes, [true], "completion must not start a newer request for the captured old open scope");
        assert.match(container.textContent ?? "", panel === "review" ? /决定已保存/ : /已标记为已读/);
      });
      for (const failed of [false, true]) await check(`${panel}: late ${failed ? "rejection" : "success"} after unmount cannot refresh or alter a new panel`, async () => {
        await reset(panel); await begin(panel);
        await unmount();
        await mount(panel, true, { ...projection, workId: "newly-selected-work", title: "New selection" });
        await complete(panel, failed);
        assert.deepEqual(refreshes, []);
        assert.doesNotMatch(container.textContent ?? "", /决定已保存|已标记为已读|late provider failure/);
        const button = [...container.querySelectorAll("button")].find(item => item.textContent === (panel === "review" ? "采纳成果" : "标记已读"));
        assert.equal(button?.disabled, false, "the new view is not controlled by the old action's busy state");
      });
    }
    await check("review: a current version-conflict reply refreshes the latest scope without claiming success", async () => {
      await reset("review"); await begin("review");
      await render("review", true);
      await act(async () => reviewReply.resolve({ ok: false, code: "version_conflict", message: "Current evidence changed" }));
      assert.deepEqual(refreshes, [true]);
      assert.match(container.textContent ?? "", /Current evidence changed/);
      assert.doesNotMatch(container.textContent ?? "", /决定已保存/);
    });
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
    await check("workspace: repeated state refreshes keep one inspector panel and both historical/current cards", async () => {
      await unmount(); testDocument.body.replaceChildren();
      const originalState = useAppStore.getState();
      const errors: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errors.push(args); originalError(...args); };
      const owner = { botId: "owner", displayName: "Owner", status: "active" } as BotDto;
      let current: WorkProjectionDto = { ...projection, cards: [
        { ...projection.cards![0], cardKey: "history", semanticCardKey: "history", intentRevision: 1, currency: "historical" },
        projection.cards![0],
      ], phase4: { subscriptions: [], offlineGaps: [], causal: [], deadlineRevision: 1,
        host: { authorityId: "test", sessionId: "test", online: true, activeSince: 1 },
        budget: { windowId: "window", policyRevision: 1, scope: "window", periodStartAt: 1,
          limitTokens: 500000, committedTokens: 5, reservedTokens: 0, unknownTokens: 0,
          unknownUsageCount: 0, availableTokens: 499995, autoRollover: false, carryPolicy: "none", status: "open" } } };
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
        const saveBudget = () => [...container.querySelectorAll("button")].find(button => button.textContent === "保存预算政策")!;
        const input = () => container.querySelector<HTMLInputElement>('[aria-label="预算上限"]')!;
        assert.equal(saveBudget().disabled, true, "an unchanged policy cannot be submitted");
        assert.equal(input().value, "500000");
        // linkedom does not implement React's native input/change tracking. Drive
        // the mounted input's real onChange callback, then assert committed DOM.
        const editBudget = async (value: string) => {
          const field = input();
          const propsKey = Object.keys(field).find(key => key.startsWith("__reactProps$"))!;
          const props = (field as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[propsKey];
          await act(async () => props.onChange({ target: { value } }));
        };
        await editBudget("600000");
        assert.equal(saveBudget().disabled, false, "a changed valid policy enables save");
        await act(async () => useAppStore.setState({ botWorks: [{ ...current, stateVersion: 8 }] }));
        assert.equal(input().value, "600000", "unrelated state refresh retains the edit");
        for (const invalid of ["", "-1", "1.5", "9007199254740992", "500000", "0500000"]) {
          await editBudget(invalid);
          assert.equal(saveBudget().disabled, true, `invalid or numerically unchanged budget ${invalid} cannot save`);
        }
        await editBudget("600000");
        assert.match(container.querySelector('[data-message-id="stopped"]')!.textContent!, /回复已停止/);
        assert.doesNotMatch(container.querySelector('[data-message-id="stopped"]')!.textContent!, /处理中|正在回复|等待回复/);
        for (let version = 8; version <= 14; version++) {
          current = { ...current, stateVersion: version,
            cards: current.cards!.map(card => card.cardKey === "card" ? { ...card, summary: `Current result ${version}` } : card),
            phase4: { ...current.phase4!, budget: { ...current.phase4!.budget, limitTokens: version * 100000 } } };
          await act(async () => useAppStore.setState({ botWorks: [current] }));
          assert.equal(container.querySelectorAll('[aria-label="结果卡片与证据"]').length, 1);
          assert.equal(container.querySelectorAll('[aria-label="成果评审与结束"]').length, 1);
          assert.equal(container.querySelectorAll('[aria-label="结果卡片"]').length, 2, "distinct history is retained, not deduplicated away");
          assert.equal([...container.querySelectorAll("summary")].filter(item => item.textContent === "展开诊断证据").length, 1);
          assert.equal([...container.querySelectorAll("h3")].filter(item => item.textContent === "外部通知").length, 1);
          assert.match(container.textContent!, new RegExp(`Current result ${version}`));
          if (version > 8) assert.doesNotMatch(container.textContent!, new RegExp(`Current result ${version - 1}`));
          assert.equal(input().value, String(version * 100000), "remote policy changes replace the old input");
          assert.equal(saveBudget().disabled, true);
        }
        assert.equal(errors.filter(args => args.some(arg => String(arg).includes("same key"))).length, 0);
      } finally {
        await unmount(); useAppStore.setState(originalState, true); console.error = originalError;
      }
    });
    console.log(`Bot Work review UI: ${count} React lifecycle scenarios passed (controlled API promises, no real IPC/browser claim)`);
  } finally {
    await unmount(); useAppStore.setState({ refreshBotWork: originalRefresh });
    testDocument.body.replaceChildren();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
