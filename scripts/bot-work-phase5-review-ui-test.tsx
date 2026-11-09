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
Object.assign(globalThis, { window: testWindow, document: testDocument, IS_REACT_ACT_ENVIRONMENT: true });
// linkedom has no layout engine, matchMedia or native dialog methods. Supply only
// those browser contracts here; actual modal focus/resize is verified in Electron.
Object.defineProperty(testWindow, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
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
  await run(); count += 1; console.log(`PASS ${count}: ${name}`);
}

async function main() {
  try {
    await check("review: mixed environments are visible before entry and groups select the actual batch", async () => {
      await reset("review");
      const value = { ...projection, criteria: [...projection.criteria,
        { ...projection.criteria[0], id: "linux-one", text: "Linux bytes", requiredEnvironment: "Linux shell" },
        { ...projection.criteria[0], id: "linux-two", text: "Linux metadata", requiredEnvironment: "Linux shell" }] };
      await render("review", false, value);
      await change("批量实测 criterion", true); await change("批量实测 linux-one", true);
      assert.match(container.textContent!, /所选条件要求不同环境/);
      assert.equal([...container.querySelectorAll("button")].find(item => item.textContent === "带入要求环境")!.disabled, true);
      await click("选择此组并带入环境：Linux shell");
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="实测环境"]')!.value, "Linux shell");
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="批量实测 criterion"]')!.checked, false);
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="批量实测 linux-two"]')!.checked, true);
      // The single selector still points at Windows. Bring must use the batch.
      await change("实测环境", ""); await click("带入要求环境");
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="实测环境"]')!.value, "Linux shell");
      assert.equal(reviewRequests.length, 0, "group selection is not evidence submission");
    });
    await check("review: cover only selected eligible attempts with explicit current evidence and one guarded request", async () => {
      await reset("review");
      const gap = { factId: "gap-denied", workId: work.workId, bindingId: "execution-old", intentRevision: 2,
        inputSnapshotId: "input:2", createdAt: 1, itemId: "approval-denied", task: "Old denied read command",
        required: true, dependencies: [], criterionIds: [], outcome: "not_started" as const,
        nativeStatus: "host_approval_not_started", summary: "The earlier command was not admitted", artifactRefs: [],
        writeConflicts: [], coverageEligible: true };
      const value: WorkProjectionDto = { ...projection,
        criteria: [{ ...projection.criteria[0], status: "satisfied", verifiedIntentRevision: 2, evidenceRefs: ["evidence-real"] }],
        phase3: { ...projection.phase3!, gaps: [gap, { ...gap, factId: "gap-unknown", outcome: "unknown", coverageEligible: false }] } };
      await render("review", false, value);
      const gaps = container.querySelector('[aria-label="必要子项缺口"]')!;
      const entry = gaps.querySelector("li details")!;
      assert.equal(entry.hasAttribute("open"), false, "long gap details begin collapsed");
      assert.equal(container.querySelector('[aria-label="覆盖未执行缺口 gap-unknown"]'), null);
      await change("覆盖未执行缺口 gap-denied", true);
      await change("缺口覆盖成果", "accepted"); await change("缺口覆盖验收 criterion", true);
      await change("缺口覆盖依据", "The actual scoped wc receipt verifies the same requested byte count");
      const button = () => [...container.querySelectorAll("button")].find(item => item.textContent === "记录已由后续证据覆盖")!;
      assert.equal(button().disabled, true);
      assert.match(gaps.textContent ?? "", /还不能提交：请勾选确认所选动作不再需要执行/,
        "a disabled coverage submit must state which inputs are still missing");
      await change("确认未执行动作已覆盖", true);
      await render("review", false, { ...value, stateVersion: 8 });
      assert.equal(button().disabled, true, "external updates cannot silently rebase the decision");
      await click("已核对最新状态，继续评审");
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="确认未执行动作已覆盖"]')!.checked, false);
      await change("确认未执行动作已覆盖", true);
      await change("缺口覆盖依据", "The scoped wc receipt still verifies the same byte count after review");
      assert.equal(button().disabled, true, "editing after confirmation must invalidate the confirmation");
      assert.match(container.textContent ?? "", /内容已变更，确认已失效/,
        "editing after confirmation must say the confirmation was invalidated");
      await change("确认未执行动作已覆盖", true);
      await click("记录已由后续证据覆盖");
      assert.equal(button().disabled, true, "pending request cannot submit again");
      const request = reviewRequests[0]; assert.equal(request.kind, "cover_not_started");
      if (request.kind !== "cover_not_started") throw Error("wrong request");
      assert.deepEqual(request.request.factIds, ["gap-denied"]);
      assert.deepEqual(request.request.criterionIds, ["criterion"]);
      assert.equal(request.request.deliverableId, "accepted");
      assert.equal(request.request.versionGuard.expectedStateVersion, 8);
      assert.equal(request.request.artifactSnapshotId, "artifacts:7");
      assert.equal(reviewRequests.length, 1);
      await complete("review", true);
      reviewReply = deferred<WorkControlResult>();
      await click("重试原评审决定");
      assert.deepEqual(reviewRequests[1], request, "uncertain retry preserves original decision and identity");
      await complete("review");
    });
    await check("review: batch evidence submits selected criteria once, preserving snapshot guards", async () => {
      await reset("review");
      const value = { ...projection, criteria: [...projection.criteria,
        { ...projection.criteria[0], id: "second", text: "Second verified condition" },
        { ...projection.criteria[0], id: "other-os", text: "Other environment", requiredEnvironment: "Linux" }] };
      await render("review", false, value);
      await change("批量实测 criterion", true); await change("批量实测 second", true);
      await click("带入要求环境"); await change("实测版本或记录", "local real test: sha256");
      await click("记录实测通过");
      assert.equal(reviewRequests.length, 1);
      const request = reviewRequests[0]; assert.equal(request.kind, "feedback");
      if (request.kind !== "feedback") throw Error("wrong request");
      assert.deepEqual(request.request.criterionIds, ["criterion", "second"]);
      assert.equal(request.request.versionGuard.expectedStateVersion, 7);
      assert.equal(request.request.artifactSnapshotId, "artifacts:7");
      await complete("review");
      await change("批量实测 other-os", true);
      assert.equal([...container.querySelectorAll("button")].find(item => item.textContent === "记录实测通过")!.disabled, true);
      assert.match(container.textContent!, /按环境分批提交/);
      await render("review", false, { ...value, stateVersion: 8 });
      assert.match(container.textContent!, /已核对最新状态/);
      assert.equal(reviewRequests.length, 1, "background changes must not resubmit or auto-confirm evidence");
    });
    await check("review: necessary gaps list names, reasons and source bindings before closure", async () => {
      await reset("review");
      await render("review", false, { ...projection, phase3: { ...projection.phase3!, gaps: [{
        factId: "gap-one", workId: work.workId, bindingId: "execution-old", intentRevision: 2, inputSnapshotId: "input:2", createdAt: 1,
        itemId: "read-size", task: "Read actual byte count", required: true, dependencies: [], criterionIds: ["criterion"],
        outcome: "blocked", nativeStatus: "completed", summary: "No actual wc receipt", artifactRefs: [], writeConflicts: [],
      }] } });
      const gaps = container.querySelector('[aria-label="必要子项缺口"]');
      assert.ok(gaps); assert.match(gaps.textContent!, /Read actual byte count/);
      assert.match(gaps.textContent!, /No actual wc receipt/); assert.match(gaps.textContent!, /execution-old/);
    });
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
    await check("review: ordinary criteria have an evidence-backed explicit verification action", async () => {
      await reset("review");
      assert.equal(container.querySelector('[aria-label="普通验收确认"]'), null, "real-environment criteria cannot be attested");
      const ordinary = { ...projection, criteria: [{ ...projection.criteria[0], requiresRealEnvironmentCheck: false, requiredEnvironment: undefined }] };
      await render("review", false, ordinary);
      await change("普通验收依据", "Checked each result against the requested list");
      await click("确认此项通过");
      assert.equal(reviewRequests.length, 1);
      const request = reviewRequests[0]; assert.equal(request.kind, "attest_criteria");
      if (request.kind === "attest_criteria") {
        assert.equal(request.request.inputSnapshotId, projection.inputSnapshotId);
        assert.equal(request.request.artifactSnapshotId, projection.phase3!.artifactSnapshotId);
        assert.deepEqual(request.request.criterionUpdates, [{ criterionId: "criterion", status: "met", evidence: "Checked each result against the requested list" }]);
      }
      await complete("review");
    });
    await check("review: required environment is copied only by an explicit click and is not test evidence", async () => {
      await reset("review");
      const environment = () => container.querySelector<HTMLInputElement>('[aria-label="实测环境"]')!;
      const pass = () => [...container.querySelectorAll("button")].find(button => button.textContent === "记录实测通过")!;
      assert.equal(environment().value, "", "a requirement is not proof of the user's environment");
      await click("带入要求环境");
      assert.equal(environment().value, "Windows");
      assert.equal(pass().disabled, true, "copying a name cannot substitute for a test record");
      assert.equal(reviewRequests.length, 0);
      await click("带入要求环境");
      assert.equal(reviewRequests.length, 0, "repeated copy has no backend effect");
      await change("实测版本或记录", "actual-machine:record-1");
      await click("记录实测通过");
      const request = reviewRequests[0]; assert.equal(request.kind, "feedback");
      if (request.kind === "feedback") {
        assert.equal(request.request.environment, "Windows");
        assert.equal(request.request.sourceRef, "actual-machine:record-1");
        assert.equal(request.request.versionGuard.expectedStateVersion, 7);
      }
      await complete("review");
      await render("review", false, { ...projection, stateVersion: 8,
        criteria: [{ ...projection.criteria[0], requiredEnvironment: "Omarchy/Wayland" }] });
      assert.equal(environment().value, "Windows", "new requirements cannot silently relabel old evidence");
      assert.equal([...container.querySelectorAll("button")].find(button => button.textContent === "带入要求环境")!.disabled, true);
      await click("已核对最新状态，继续评审");
      await click("带入要求环境");
      assert.equal(environment().value, "Omarchy/Wayland");
      assert.equal(reviewRequests.length, 1, "explicit rebasing and copy still do not submit feedback");
    });
    await check("review: closure explains its disabled state beside the button and offers guarded latest review", async () => {
      await reset("review");
      const closeButton = () => [...container.querySelectorAll("button")].find(button => button.textContent === "确认结束事项")!;
      const reason = () => testDocument.getElementById(closeButton().getAttribute("aria-describedby")!)?.textContent;
      assert.match(reason()!, /填写结束依据/);
      await change("事项结束依据", "Checked current output");
      assert.match(reason()!, /勾选确认/);
      await change("确认事项结束", true);
      assert.equal(closeButton().disabled, false);
      await render("review", false, { ...projection, stateVersion: 8 });
      assert.equal(closeButton().disabled, true);
      assert.match(reason()!, /事项已有更新.*核对最新成果/);
      assert.equal(closeButton().closest("details")!.textContent!.includes("已核对最新状态，继续结束"), true);
      assert.equal(reviewRequests.length, 0);
      await click("已核对最新状态，继续结束");
      assert.equal(closeButton().disabled, true, "renewed state review does not renew the closure confirmation");
      assert.match(reason()!, /勾选确认/);
      assert.equal(container.querySelector<HTMLTextAreaElement>('[aria-label="事项结束依据"]')!.value, "Checked current output");
      await change("确认事项结束", true);
      await click("确认结束事项");
      assert.equal(reviewRequests[0].kind, "close");
      assert.equal(reviewRequests[0].request.versionGuard.expectedStateVersion, 8);
      assert.match(reason()!, /正在保存决定/);
      await complete("review", true);
      assert.match(reason()!, /上次决定尚未确认.*重试原评审决定/);
      await render("review", false, { ...projection, stateVersion: 9 });
      assert.equal([...container.querySelectorAll("button")].find(button => button.textContent === "已核对最新状态，继续结束")!.disabled, true,
        "uncertain original decisions cannot be rebound by the local recovery button");
      reviewReply = deferred<WorkControlResult>();
      await click("重试原评审决定");
      assert.deepEqual(reviewRequests[1], reviewRequests[0]);
      await complete("review");
    });
    await check("review: background versions retain all edits and require explicit rebasing before submission", async () => {
      await reset("review");
      await change("实测环境", "Windows"); await change("实测版本或记录", "fixture:original-version");
      await change("实测说明", "Original test details"); await change("事项结束依据", "Reviewed closure basis");
      await change("确认事项结束", true);
      for (let version = 8; version <= 10; version++) {
        await render("review", false, { ...projection, stateVersion: version });
        assert.equal(container.querySelector<HTMLInputElement>('[aria-label="实测环境"]')!.value, "Windows");
        assert.equal(container.querySelector<HTMLInputElement>('[aria-label="实测版本或记录"]')!.value, "fixture:original-version");
        assert.equal(container.querySelector<HTMLTextAreaElement>('[aria-label="实测说明"]')!.value, "Original test details");
        assert.equal(container.querySelector<HTMLTextAreaElement>('[aria-label="事项结束依据"]')!.value, "Reviewed closure basis");
        assert.match(container.textContent!, /已保留你的填写内容和原评审版本/);
        assert.equal([...container.querySelectorAll("button")].find(b => b.textContent === "记录实测通过")!.disabled, true);
      }
      assert.equal(reviewRequests.length, 0);
      await click("已核对最新状态，继续评审");
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="确认事项结束"]')!.checked, false, "closure confirmation must be renewed after rebasing");
      await click("记录实测通过");
      assert.equal(reviewRequests[0].request.versionGuard.expectedStateVersion, 10);
      await complete("review");
    });
    for (const control of ["accept", "reply"] as const) for (const changeKind of ["input", "intent", "artifact"] as const) {
      await check(`review: ${control} success keeps other drafts pinned before a later ${changeKind} change`, async () => {
        await reset("review");
        const question = (id: string) => ({ blockerId: id, workId: projection.workId, reason: `Question ${id}`, kind: "operational" as const,
          reasonCode: "user-input" as const, sourceRef: `source:${id}`, waitingForUserInput: true, status: "open" as const, createdAt: 1,
          details: { userInput: { kind: "reply", inputSnapshotId: projection.inputSnapshotId, intentRevision: 2, ownerEpoch: 3 } } });
        const original = { ...projection, criteria: [{ ...projection.criteria[0], requiresRealEnvironmentCheck: false, requiredEnvironment: undefined }],
          blockers: [question("first"), question("second")] };
        await render("review", false, original);
        await change("普通验收依据", "Attestation for A"); await change("实测环境", "Windows");
        await change("实测版本或记录", "record:A"); await change("实测说明", "Test detail for A");
        await change("事项结束依据", "Closure for A"); await change("确认事项结束", true);
        for (const id of ["first", "second"]) {
          await change(`问题回复 ${id}`, `Answer for A ${id}`); await change(`回复依据 ${id}`, `Evidence for A ${id}`);
        }
        await click(control === "accept" ? "采纳成果" : "保存回复");
        assert.equal(reviewRequests[0].kind, control === "accept" ? "accept_deliverable" : "reply_user_input");
        await complete("review");
        // A later push, after the successful request has fully settled, must not
        // silently relabel evidence entered for A as evidence about B.
        const next = { ...original, stateVersion: 8,
          ...(changeKind === "input" ? { inputSnapshotId: "input:B" } : {}),
          ...(changeKind === "intent" ? { intentRevision: 3 } : {}),
          ...(changeKind === "artifact" ? { phase3: { ...original.phase3!, artifactSnapshotId: "artifacts:B" } } : {}) };
        await render("review", false, next);
        assert.match(container.textContent!, /已保留你的填写内容和原评审版本/);
        for (const [label, expected] of [["普通验收依据", "Attestation for A"], ["实测环境", "Windows"],
          ["实测版本或记录", "record:A"], ["实测说明", "Test detail for A"], ["事项结束依据", "Closure for A"],
          ["问题回复 second", "Answer for A second"], ["回复依据 second", "Evidence for A second"]]) {
          assert.equal(container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.value, expected);
        }
        for (const label of ["确认此项通过", "记录实测通过", "保存回复", "确认结束事项"]) {
          assert.equal([...container.querySelectorAll("button")].find(button => button.textContent === label)!.disabled, true);
        }
        assert.equal(reviewRequests.length, 1, "no retained draft can submit to B implicitly");
        await click("已核对最新状态，继续评审");
        reviewReply = deferred<WorkControlResult>();
        await click("确认此项通过");
        const deliberate = reviewRequests[1]; assert.equal(deliberate.kind, "attest_criteria");
        if (deliberate.kind === "attest_criteria") {
          assert.equal(deliberate.request.inputSnapshotId, next.inputSnapshotId);
          assert.equal(deliberate.request.artifactSnapshotId, next.phase3!.artifactSnapshotId);
          assert.equal(deliberate.request.versionGuard.expectedIntentRevision, next.intentRevision);
          assert.equal(deliberate.request.versionGuard.expectedStateVersion, 8);
          assert.equal(deliberate.request.criterionUpdates[0].evidence, "Attestation for A", "only explicit review can rebind retained evidence");
        }
        await complete("review");
        await render("review", false, { ...next, stateVersion: 9 });
        assert.match(container.textContent!, /已保留你的填写内容和原评审版本/, "even successful verification does not unpin other retained drafts");
      });
    }
    await check("review: uncertain decisions retry their original operation and snapshot even after remote changes", async () => {
      await reset("review"); await begin("review"); const original = reviewRequests[0];
      await complete("review", true);
      await render("review", false, { ...projection, stateVersion: 8, ownerEpoch: 4, inputSnapshotId: "input:new" });
      assert.equal([...container.querySelectorAll("button")].find(b => b.textContent === "采纳成果")!.disabled, true);
      reviewReply = deferred<WorkControlResult>();
      await click("重试原评审决定");
      assert.deepEqual(reviewRequests[1], original);
      await complete("review");
    });
    await check("review: only typed input questions expose a reply and unsafe blockers have no clear action", async () => {
      await reset("review");
      const blocker = { blockerId: "question", workId: projection.workId, reason: "Which date?", kind: "operational" as const,
        reasonCode: "user-input" as const, sourceRef: "question:source", waitingForUserInput: true, status: "open" as const, createdAt: 1,
        details: { userInput: { kind: "reply", inputSnapshotId: projection.inputSnapshotId, intentRevision: 2, ownerEpoch: 3 } } };
      const value = { ...projection, blockers: [blocker,
        { ...blocker, blockerId: "write-conflict", kind: "write_conflict" as const, reasonCode: undefined },
        { ...blocker, blockerId: "unknown", unknownExternalEffectRef: "effect" },
        { ...blocker, blockerId: "generic", reasonCode: undefined, details: undefined }] };
      await render("review", false, value);
      assert.equal(container.querySelectorAll('[aria-label="回复待补充信息"]').length, 1);
      await change("问题回复 question", "November 8"); await change("回复依据 question", "User reporting plan");
      await click("保存回复");
      const request = reviewRequests[0]; assert.equal(request.kind, "reply_user_input");
      if (request.kind === "reply_user_input") {
        assert.equal(request.request.blockerId, "question"); assert.equal(request.request.reply, "November 8");
        assert.match(request.request.blockerSnapshot, /question:source/);
      }
      await complete("review");
    });
    await check("review: proven legacy report needs explicit information-only classification and preserves proof", async () => {
      await reset("review");
      const blocker = { blockerId: "legacy-proven", workId: projection.workId, reason: "Which date?", kind: "operational" as const,
        reportedByBotId: projection.ownerBotId, waitingForUserInput: true, status: "open" as const, createdAt: 1,
        legacyUserInput: { reportOperationId: "original-report", blockerSnapshot: "original-proof", inputSnapshotId: projection.inputSnapshotId,
          intentRevision: projection.intentRevision, ownerEpoch: projection.ownerEpoch } };
      const value = { ...projection, blockers: [blocker] };
      await render("review", false, value);
      await change("问题回复 legacy-proven", "November 8"); await change("回复依据 legacy-proven", "User's dated reporting plan");
      const save = () => [...container.querySelectorAll("button")].find(button => button.textContent === "保存回复")!;
      assert.equal(save().disabled, true, "reply text alone never classifies an untyped question");
      await change("确认仅信息问题 legacy-proven", true);
      await render("review", false, { ...value, stateVersion: 8 });
      assert.equal(save().disabled, true, "classification does not bypass version changes");
      await click("已核对最新状态，继续评审");
      assert.equal(save().disabled, true, "latest-state review requires renewing the information-only confirmation");
      await change("确认仅信息问题 legacy-proven", true);
      await click("保存回复");
      const request = reviewRequests[0]; assert.equal(request.kind, "reply_legacy_user_input");
      if (request.kind === "reply_legacy_user_input") {
        assert.equal(request.request.reportOperationId, "original-report"); assert.equal(request.request.blockerSnapshot, "original-proof");
        assert.equal(request.request.confirmedInformationOnly, true); assert.equal(request.request.versionGuard.expectedStateVersion, 8);
      }
      await complete("review");
      assert.equal(container.querySelector<HTMLInputElement>('[aria-label="确认仅信息问题 legacy-proven"]')!.checked, false);
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
    await check("workspace: a legacy blocker opens an owner reply draft without overwriting, sending or clearing", async () => {
      await unmount(); testDocument.body.replaceChildren();
      const originalState = useAppStore.getState(); const beforeReviews = reviewRequests.length; let sends = 0;
      const owner = { botId: "owner", displayName: "Owner", status: "active", authorization: work.authorization } as BotDto;
      const member = { botId: "member", displayName: "Member", status: "active", authorization: work.authorization } as BotDto;
      const legacy: WorkProjectionDto = { ...projection, team: { workId: projection.workId,
        intentRevision: projection.intentRevision, inputSnapshotId: projection.inputSnapshotId,
        ownerEpoch: projection.ownerEpoch, ownerBotId: projection.ownerBotId, createdAt: work.createdAt,
        state: "awaiting_review", ownerResponsibility: "Review results",
        members: [{ botId: "member", responsibility: "Read sources", delegatedScope: ["workspace:read"] }], executions: [] },
        blockers: [{ blockerId: "legacy-question", workId: work.workId, reason: "Please clarify the expected date", kind: "operational" as const,
          waitingForUserInput: true, status: "open" as const, createdAt: 1 }] };
      try {
        useAppStore.setState({ activeBotId: "member", botIdentities: [owner, member], selectedWorkId: legacy.workId,
          botWorks: [legacy], botDraft: "Member unfinished draft", botDrafts: { member: "Member unfinished draft", owner: "Owner unfinished draft" },
          refreshBotHistory: async () => {}, refreshBotWork: async () => {}, submitBotDraft: async () => { sends += 1; } });
        const { createRoot } = await import("react-dom/client");
        container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
        await act(async () => root!.render(<StrictMode><BotWorkspacePage /></StrictMode>));
        const tabs = [...container.querySelectorAll<HTMLButtonElement>(".bot-view-tabs button")];
        assert.equal(tabs.length, 3);
        assert.deepEqual(tabs.map(tab => tab.querySelector("span")?.textContent), ["对话", "未结束", "已结束"]);
        assert.doesNotMatch(container.textContent!, /待你决定/);
        await act(async () => tabs[1].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        assert.match(container.querySelector(".bot-work-browser")!.textContent!, /Review current output/,
          "a task needing real input remains reachable in the active view");
        await act(async () => tabs[2].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
        await act(async () => tabs[0].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
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
          assert.equal(container.querySelectorAll('[aria-label="成果评审与结束"]').length, 1);
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
      assert.match(container.textContent!, /文件生成不代表验收通过/);
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
      await act(async () => root!.render(<BotMessage botName="MyBuddy" works={[{ ...projection, generatedArtifacts: generated }]}
        onOpenWork={() => {}} onCancel={() => {}} message={{ messageId: "result-long", conversationId: "chat", botId: "owner", requestId: "r", ordinal: 1,
          role: "assistant", status: "completed", text: "完整原文与原始引用", workIds: [projection.workId], createdAt: 1, updatedAt: 1,
          workFeedback: { workId: projection.workId, eventId: "result:b", kind: "result", category: "result", executionId: "b", report: {
            title: "六任务中的 CSV 报告", summary: "报告结论\n\n" + "完整内容。".repeat(350), artifactRefs: ["/snap/hash-py", "/snap/hash-csv"],
            reviewStatus: "proposed", current: true, notices: ["尚未覆盖：实机验收"],
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
