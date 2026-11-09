/** Headless real React DOM events/lifecycle only; not desktop focus/layout acceptance. */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkActionApprovalDto, WorkActionDecision, WorkActionDecisionResult } from "../src/shared/bot-work-approval";
import { workApprovalIpcHandler } from "../src/main/agent/work/WorkApprovalIpc";
const { window: win, document: doc } = parseHTML("<html><body></body></html>");
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
Object.assign(globalThis, { window: win, document: doc, localStorage: storage, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(win, "localStorage", { value: storage });
Object.defineProperty(doc, "oninput", { value: null });
Object.defineProperty(win, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(win.HTMLElement.prototype, { show() { this.setAttribute("open", ""); }, showModal() { this.setAttribute("open", ""); }, close() { this.removeAttribute("open"); }, scrollTo() {} });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function bot(botId: string, displayName: string, responsibilitySummary = ""): BotDto {
  return { botId, userId: "user-local-primary", displayName, responsibilitySummary, status: "active",
    expertProfile: { expertId: "default", revision: "default", version: 1, systemPromptHash: "default",
      allowedMcpIds: [], allowedSkillIds: [], allowedConnectorIds: [], capturedAt: 1, desiredVersion: 1, activeVersion: 1 },
    memoryScope: { personalMemoryNamespace: `bot:${botId}`, sharePersonalMemoryWithTeam: false,
      allowUnconfirmedSpeculationInMemory: false },
    authorization: { allowedScopes: [], targetWhitelist: [], allowGitBranchOrWorktree: false, allowRedelegation: false },
    foregroundAllowedTools: [], notificationPolicyJson: "{}", createdAt: 1, updatedAt: 1 };
}
const mybuddy = bot("bot-mybuddy-default", "MyBuddy");
const other = bot("other-bot", "Existing assistant");
const work: WorkProjectionDto = { workId: "mybuddy-work", title: "Existing Work", mode: "once", lifecycle: "active",
  ownerBotId: mybuddy.botId, ownerEpoch: 1, intentRevision: 1, sourceVersion: 1, stateVersion: 1,
  inputSnapshotId: "input", inputSnapshotBound: true, goalSources: [], criteria: [], acceptedDeliverableIds: [],
  deliverables: [], blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [],
  nextSteps: [], updatedAt: 1 };
let sequence = 0;
function fixture(overrides: Partial<WorkActionApprovalDto> = {}): WorkProjectionDto {
  const approval: WorkActionApprovalDto = { approvalId: `approval-${++sequence}`, workId: work.workId, bindingId: "binding", taskId: "task",
    operationId: "operation", toolName: "external.send", summary: "Send <img src=x onerror=alert(1)>", detail: "<script>steal()</script>",
    requiredScope: "external_communication", scopeMissing: true, intentRevision: 1, inputSnapshotId: "input", ownerEpoch: 1,
    status: "pending", version: 1, createdAt: Date.now(), expiresAt: Date.now() + 60000, ...overrides };
  return { ...work, approvals: [approval] };
}
let requests: WorkActionDecision[] = [], refreshes = 0;
let receipt = deferred<WorkActionDecisionResult>();
const api = { botWork: { decideAction: async (request: WorkActionDecision) => { requests.push(structuredClone(request)); return receipt.promise; } } };
Object.defineProperty(win, "api", { value: api });
let root: Root | undefined, container: HTMLElement;
let createRoot: typeof import("react-dom/client")["createRoot"];
let Card: typeof import("../src/renderer/src/components/pages/BotWorkApprovals")["BotWorkApprovals"];
let store: typeof import("../src/renderer/src/store/appStore")["useAppStore"];
async function unmount() { if (root) { await act(async () => root!.unmount()); root = undefined; container.remove(); } }
async function render(projection: WorkProjectionDto) {
  if (!root) { container = doc.body.appendChild(doc.createElement("div")); root = createRoot(container); }
  await act(async () => root!.render(<StrictMode><Card work={projection} /></StrictMode>));
}
async function reset(projection = fixture()) { await unmount(); requests = []; refreshes = 0; receipt = deferred(); await render(projection); return projection; }
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>(".bot-approval-actions button")];
function click(node: HTMLElement) { if (!(node as HTMLButtonElement).disabled) node.dispatchEvent(new win.Event("click", { bubbles: true, cancelable: true })); }
async function consent() { const node = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  // linkedom has no native checkbox toggle. Supply the native click's checked state before dispatching it.
  await act(async () => { node.checked = true; click(node); }); }
let passed = 0, failed = 0;
async function check(name: string, body: () => void | Promise<void>) { try { await body(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}`, error); } }
async function main() {
  ({ createRoot } = await import("react-dom/client"));
  ({ BotWorkApprovals: Card } = await import("../src/renderer/src/components/pages/BotWorkApprovals"));
  ({ useAppStore: store } = await import("../src/renderer/src/store/appStore"));
  store.setState({ refreshBotWork: async () => { refreshes++; }, refreshBotHistory: async () => {} });
  await check("missing scope requires explicit checkbox; details are text, not executable HTML", async () => {
    await reset(); assert.equal(buttons()[0].disabled, true); assert.equal(buttons()[1].disabled, false);
    await act(async () => click(buttons()[0])); assert.equal(requests.length, 0);
    assert.equal(container.querySelector("script,img"), null); assert.match(container.textContent!, /<script>steal/);
    await consent(); assert.equal(buttons()[0].disabled, false);
    await act(async () => click(buttons()[0])); assert.equal(requests[0].approved, true); assert.equal(requests[0].grantScopeOnce, true);
    assert.ok(buttons().every(button => button.disabled));
  });
  await check("deny needs no scope grant and sends exactly one request for same-batch double click", async () => {
    await reset(); const deny = buttons()[1]; await act(async () => { click(deny); click(deny); });
    assert.equal(requests.length, 1); assert.equal(requests[0].approved, false); assert.equal(requests[0].grantScopeOnce, false);
  });
  await check("unknown outcome freezes the exact request across projection refresh and remount", async () => {
    const projection = await reset(); await consent(); await act(async () => click(buttons()[0])); const original = requests[0];
    await act(async () => receipt.reject(new Error("lost receipt")));
    assert.equal(buttons()[1].disabled, true); assert.ok(container.querySelector('[role="alert"]'));
    await render({ ...projection, stateVersion: 9 }); receipt = deferred();
    await act(async () => click(buttons()[0])); assert.deepEqual(requests[1], original);
    await act(async () => receipt.reject(new Error("lost receipt again")));
    await unmount(); await render({ ...projection, stateVersion: 10 });
    assert.equal(buttons()[1].disabled, true); receipt = deferred();
    await act(async () => click(buttons()[0])); assert.deepEqual(requests[2], original);
  });
  await check("stale decision response cannot allow an opposite decision from the old projection", async () => {
    await reset({ ...fixture(), approvals: fixture({ scopeMissing: false }).approvals });
    await act(async () => click(buttons()[0]));
    await act(async () => receipt.resolve({ ok: false, code: "version_conflict", message: "projection is stale" }));
    await act(async () => click(buttons()[1])); assert.equal(requests.length, 1); assert.ok(refreshes > 0);
  });
  await check("confirmed decision plus failed refresh never resends or changes the decision", async () => {
    const projection = await reset(fixture({ scopeMissing: false }));
    store.setState({ refreshBotWork: async () => { throw new Error("refresh failed"); } });
    try {
      await act(async () => click(buttons()[0]));
      await act(async () => receipt.resolve({ ok: true, replayed: false, approval: { ...projection.approvals![0], status: "approved" } }));
      assert.match(container.textContent!, /决定已保存/); assert.ok(buttons().every(button => button.disabled));
      await unmount(); await render(projection); await act(async () => buttons().forEach(click)); assert.equal(requests.length, 1);
    } finally { store.setState({ refreshBotWork: async () => { refreshes++; } }); }
  });
  await check("conversation and details share one synchronous in-flight decision lock", async () => {
    const projection = await reset(fixture({ scopeMissing: false }));
    await act(async () => root!.render(<><Card work={projection} /><Card work={projection} /></>));
    // 每张卡：允许本次 / 拒绝 / 暂不处理（+ 条件性的长期规则按钮）。
    const all = buttons(); assert.equal(all.length, 6);
    assert.deepEqual(all.map(button => button.textContent), ["允许本次", "拒绝", "暂不处理", "允许本次", "拒绝", "暂不处理"]);
    await act(async () => { click(all[0]); click(all[3]); }); assert.equal(requests.length, 1);
    assert.ok(buttons().every(button => button.disabled));
  });
  await check("replacement approval discards previous checkbox authorization and resolved cards disappear", async () => {
    const projection = await reset(); await consent();
    await render({ ...projection, approvals: [{ ...projection.approvals![0], version: 2, bindingId: "new-binding" }] });
    assert.equal(buttons()[0].disabled, true); assert.equal(container.querySelector<HTMLInputElement>("input")!.checked, false);
    await render({ ...projection, approvals: [{ ...projection.approvals![0], status: "denied" }] });
    assert.equal(container.querySelector(".bot-approval-card"), null);
  });
  for (const approved of [true, false]) await check(`expired unknown ${approved ? "approval" : "denial"} only retries its exact original decision`, async () => {
    const projection = await reset();
    if (approved) await consent();
    await act(async () => click(buttons()[approved ? 0 : 1])); const original = requests[0];
    await act(async () => receipt.reject(new Error("receipt lost before expiry")));
    await unmount();
    const originalNow = Date.now;
    try {
      Date.now = () => projection.approvals![0].expiresAt + 1;
      await render({ ...projection, stateVersion: 99 });
      assert.match(container.textContent!, /原决定结果待核对/);
      assert.doesNotMatch(container.textContent!, /审批已到期，默认拒绝/);
      assert.equal(buttons()[approved ? 1 : 0].disabled, true);
      assert.equal(buttons()[approved ? 0 : 1].disabled, false);
      assert.equal(container.querySelector<HTMLInputElement>("input")!.disabled, true);
      receipt = deferred();
      await act(async () => { click(buttons()[approved ? 1 : 0]); click(buttons()[approved ? 0 : 1]); });
      assert.equal(requests.length, 2); assert.deepEqual(requests[1], original);
      assert.ok(buttons().every(button => button.disabled));
      assert.doesNotMatch(container.textContent!, /审批已到期，默认拒绝/);
      await act(async () => receipt.resolve({ ok: true, replayed: true, approval: { ...projection.approvals![0], status: approved ? "approved" : "denied" } }));
      assert.match(container.textContent!, /决定已保存/); assert.ok(buttons().every(button => button.disabled));
    } finally { Date.now = originalNow; }
  });
  await check("expired approval is inert", async () => {
    await reset(fixture({ expiresAt: Date.now() - 1 })); assert.ok(buttons().every(button => button.disabled));
    await act(async () => buttons().forEach(click)); assert.equal(requests.length, 0);
  });
  await check("late completion after unmount cannot corrupt a different pending approval", async () => {
    await reset(); await act(async () => click(buttons()[1])); const oldReceipt = receipt;
    await reset(); await act(async () => oldReceipt.resolve({ ok: false, code: "already_resolved", message: "old refusal" }));
    assert.doesNotMatch(container.textContent!, /old refusal/); assert.equal(buttons()[1].disabled, false);
  });
  await check("real conversation and Work details both render the pending projection", async () => {
    await unmount(); const projection = fixture();
    store.setState({ botIdentities: [mybuddy], botIdentitiesLoaded: true, botWorks: [projection], activeBotId: mybuddy.botId,
      selectedWorkId: null, botHistories: {}, botDraft: "", botHostStatus: { online: true, isAuthority: true, authorityId: "test" } });
    const { default: Page } = await import("../src/renderer/src/components/pages/BotWorkspacePage");
    container = doc.body.appendChild(doc.createElement("div")); root = createRoot(container);
    await act(async () => root!.render(<Page />)); assert.equal(container.querySelectorAll(".bot-approval-card").length, 1);
    await act(async () => store.getState().setSelectedWorkId(projection.workId));
    assert.ok(container.querySelector(".bot-inspector-body .bot-approval-card"));
    await act(async () => store.setState({ botWorks: [{ ...projection, approvals: [] }] }));
    assert.equal(container.querySelectorAll(".bot-approval-card").length, 0);
  });
  await unmount();
  await check("IPC accepts only live host main frame at the trusted app document", () => {
    const frame = { url: "file:///app/index.html" }, sender = { mainFrame: frame, isDestroyed: () => false };
    let calls = 0; const request = { approvalId: "real" };
    let main: any = { webContents: sender, isDestroyed: () => false };
    const handler = workApprovalIpcHandler({ getMainWindow: () => main, rendererUrl: frame.url,
      decideAction: value => { assert.equal(value, request); calls++; return { ok: false, code: "not_found", message: "tested" }; } });
    const allowed = () => handler({ sender, senderFrame: frame }, request);
    allowed(); assert.equal(calls, 1);
    const denied = (event: any) => { const before = calls; assert.equal(handler(event, request).ok, false); assert.equal(calls, before); };
    denied({ sender, senderFrame: { url: frame.url } }); denied({ sender, senderFrame: null });
    denied({ sender: { ...sender }, senderFrame: frame });
    frame.url = "https://evil.test/app/index.html"; denied({ sender, senderFrame: frame });
    frame.url = "file:///app/other.html"; denied({ sender, senderFrame: frame });
    frame.url = "file:///app/index.html#/bot"; allowed(); assert.equal(calls, 2);
    sender.isDestroyed = () => true; denied({ sender, senderFrame: frame }); sender.isDestroyed = () => false;
    main.isDestroyed = () => true; denied({ sender, senderFrame: frame }); main = null; denied({ sender, senderFrame: frame });
  });
  console.log(`${passed} passed; ${failed} failed. Headless React DOM/IPC regression, not desktop acceptance.`);
  if (failed) process.exitCode = 1;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
