/**
 * Real React input/click/submit/lifecycle tests with controlled host receipts.
 * linkedom supplies no layout, native form defaults or modal focus trapping;
 * those remain separate desktop acceptance checks, not claims of this suite.
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, StrictMode, useState } from "react";
import type { Root } from "react-dom/client";
import type { CreateTeamWorkRequest, WorkTeamControlRequest, WorkTeamControlResult, WorkTeamTemplateDto } from "../src/shared/bot-work-team";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { WorkListUpdate } from "../src/shared/bot-conversation";
import type { AppState } from "../src/renderer/src/store/app/types";

const { window: testWindow, document: testDocument } = parseHTML("<html><body></body></html>");
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  clear: () => values.clear(),
};
Object.assign(globalThis, { window: testWindow, document: testDocument,
  localStorage: storage, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(testWindow, "localStorage", { configurable: true, value: storage });
// Install the browser input capability before importing react-dom. Bypassing
// React's value tracker with the native prototype setter then dispatching input
// drives the real mounted onChange event, rather than private React props.
Object.defineProperty(testDocument, "oninput", { configurable: true, value: null });
// React initializes textarea.value through the browser's defaultValue contract.
// linkedom omits that reflected property, so supply its text-content semantics.
Object.defineProperty(testWindow.HTMLTextAreaElement.prototype, "defaultValue", {
  configurable: true,
  get() { return this.textContent ?? ""; },
  set(value: string) { this.textContent = value; },
});
Object.defineProperty(testWindow, "matchMedia", { configurable: true, value: () => ({ matches: false,
  addEventListener() {}, removeEventListener() {} }) });
Object.assign(testWindow.HTMLElement.prototype, {
  show() { this.setAttribute("open", ""); },
  showModal() { this.setAttribute("open", ""); },
  close() { this.removeAttribute("open"); },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function bot(botId: string, displayName: string, responsibilitySummary = ""): BotDto {
  return { botId, userId: "user-local-primary", displayName, responsibilitySummary, status: "active",
    expertProfile: { expertId: "default", revision: "default", version: 1, systemPromptHash: "default",
      allowedMcpIds: [], allowedSkillIds: [], allowedConnectorIds: [], capturedAt: 1, desiredVersion: 1, activeVersion: 1 },
    memoryScope: { personalMemoryNamespace: `bot:${botId}`, sharePersonalMemoryWithTeam: false,
      allowUnconfirmedSpeculationInMemory: false },
    authorization: { allowedScopes: ["workspace:read"], targetWhitelist: [], allowGitBranchOrWorktree: false, allowRedelegation: false },
    foregroundAllowedTools: [], notificationPolicyJson: "{}", createdAt: 1, updatedAt: 1 };
}
const mybuddy = bot("bot-mybuddy-default", "MyBuddy");
const other = bot("other-bot", "Existing assistant");
const work: WorkProjectionDto = { workId: "mybuddy-work", title: "Existing Work", mode: "once", lifecycle: "active",
  ownerBotId: mybuddy.botId, ownerEpoch: 1, intentRevision: 1, sourceVersion: 1, stateVersion: 1,
  inputSnapshotId: "input", inputSnapshotBound: true, goalSources: [], criteria: [], acceptedDeliverableIds: [],
  deliverables: [], blockers: [], executions: [], notifications: [], subscriptionIds: [], uncoveredScope: [],
  nextSteps: [], updatedAt: 1 };
const ordinaryDraft = { title: "Ordinary Task draft" };
let root: Root | undefined;
let container: HTMLElement;
let closeCalls = 0;
let requests: CreateTeamWorkRequest[] = [];
let lookupRequests: string[] = [];
let lookupReply = deferred<WorkTeamControlResult>();
let templateCalls: WorkTeamControlRequest[] = [];
let hostTemplates: WorkTeamTemplateDto[] = [];
let forbiddenCalls: string[] = [];
let reply = deferred<WorkTeamControlResult>();
let hostBots = [mybuddy, other];
let openDialog: (() => void) | undefined;
let store: typeof import("../src/renderer/src/store/appStore")["useAppStore"];
let initialState: AppState;
let createRoot: typeof import("react-dom/client")["createRoot"];
let BotTeamDialog: typeof import("../src/renderer/src/components/pages/BotTeamDialog")["BotTeamDialog"];
const api = { botWork: {
  teamControl: async (request: WorkTeamControlRequest) => { if (request.kind === "get_by_operation") { lookupRequests.push(request.operationId); return lookupReply.promise; } if (request.kind === "list_templates") return { ok: true, templates: hostTemplates };
    if (request.kind === "save_template") { templateCalls.push(request); const template = { ...request.request.plan, templateId: "template-a", name: request.request.name, createdAt: 1 }; hostTemplates = [template]; return { ok: true, template }; }
    if (request.kind === "delete_template") { templateCalls.push(request); hostTemplates = hostTemplates.filter(item => item.templateId !== request.templateId); return { ok: true }; } if (request.kind === "create") { requests.push(structuredClone(request.request)); return reply.promise; } throw new Error("unexpected template operation"); },
  listBots: async () => hostBots,
  syncWorks: async (): Promise<WorkListUpdate> => ({ kind: "snapshot", cursor: { epoch: "create-ui", sequence: 0, scope: "open" }, works: [work] }),
  hostStatus: async () => ({ online: true, isAuthority: true, authorityId: "ui-test" }),
  history: async ({ botId }: { botId: string }) => ({ botId, conversationId: `conversation:${botId}`, revision: 1, archived: false, messages: [] }),
  sendMessage: async () => { forbiddenCalls.push("sendMessage"); throw new Error("creation must not send messages"); },
}, createTask: async () => { forbiddenCalls.push("createTask"); },
  agent: { createTask: async () => { forbiddenCalls.push("agent.createTask"); },
    sendMessage: async () => { forbiddenCalls.push("agent.sendMessage"); } },
} as unknown as Window["api"];
Object.defineProperty(testWindow, "api", { configurable: true, value: api });

function Harness() {
  const [open, setOpen] = useState(true);
  openDialog = () => setOpen(true);
  return <BotTeamDialog open={open} onClose={() => { closeCalls++; setOpen(false); }} />;
}
async function unmount() {
  if (root) { const previous = root; root = undefined; await act(async () => previous.unmount()); }
  testDocument.body.replaceChildren();
}
async function mount() {
  container = testDocument.body.appendChild(testDocument.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
}
async function reset() {
  await unmount(); values.clear(); requests = []; templateCalls = []; hostTemplates = []; forbiddenCalls = []; closeCalls = 0;
  reply = deferred<WorkTeamControlResult>(); lookupReply = deferred<WorkTeamControlResult>(); lookupRequests = []; hostBots = [mybuddy, other];
  store.setState({ ...initialState, page: "bot", activeBotId: mybuddy.botId, activeTaskId: "ordinary-task",
    draft: ordinaryDraft, botIdentities: hostBots, botIdentitiesLoaded: true, botWorks: [work], selectedWorkId: work.workId,
    botDraft: "MyBuddy draft", botDrafts: { [mybuddy.botId]: "MyBuddy draft", [other.botId]: "Other draft" },
    botHostStatus: { online: true, isAuthority: true, authorityId: "ui-test" },
    botHistories: { [mybuddy.botId]: { botId: mybuddy.botId, conversationId: "mybuddy-conversation", revision: 1, archived: false, messages: [] } },
  }, true);
  await mount();
}
function form() {
  const node = container.querySelector<HTMLFormElement>("form");
  assert.ok(node, "creation renders an actual form"); return node;
}
function submitButton() {
  const node = form().querySelector<HTMLButtonElement>('button[type="submit"]');
  assert.ok(node, "creation has a submit button"); return node;
}
async function edit(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  assert.equal(Boolean(field.disabled || field.readOnly), false, "native editing is only possible in an editable field");
  if (field.tagName === "INPUT" && !field.getAttribute("type")) field.setAttribute("type", "text");
  const prototype = field.tagName === "INPUT" ? testWindow.HTMLInputElement.prototype : testWindow.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
  await act(async () => { setter.call(field, value); field.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
}
async function fill() {
  for (const [id, value] of Object.entries({ "team-title": "Review project", "team-goal": "Review source and report evidence", "team-workspace": "/tmp/team-fixture", "team-criteria": "Sources cited" })) await edit(container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!, value);
  const checkbox = container.querySelector<HTMLInputElement>('.bot-team-member-toggle input')!;
  await act(async () => checkbox.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
  await edit(container.querySelector<HTMLTextAreaElement>(`#team-role-${other.botId}`)!, "Read documentation and report gaps");
}
// linkedom has no browser default submit action. Dispatch the same native submit
// event after a successful click on a submit button, without calling handlers.
function nativeClick(button: HTMLButtonElement) {
  if (button.disabled) return;
  const accepted = button.dispatchEvent(new testWindow.Event("click", { bubbles: true, cancelable: true }));
  if (accepted && button.type === "submit") button.closest("form")?.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
}
async function submit() {
  assert.equal(submitButton().disabled, false, "valid form must permit submission");
  await act(async () => nativeClick(submitButton()));
}
function closeButton() {
  const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => /关闭/.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
  assert.ok(node, "creation has an accessible close button"); return node;
}
async function close() { await act(async () => nativeClick(closeButton())); }
function creationReceipt(patch: Partial<import("../src/shared/bot-work").WorkDto> = {}): Extract<WorkTeamControlResult, { ok: true }> {
  const request = requests.at(-1)!;
  const created = { ...work, workId: "new-team", title: request.title, ...patch } as unknown as import("../src/shared/bot-work").WorkDto;
  return { ok: true, operationId: request.operationId, work: created,
    team: { workId: created.workId, ownerBotId: created.ownerBotId, ownerResponsibility: request.ownerResponsibility,
      members: request.members, intentRevision: created.intentRevision, ownerEpoch: created.ownerEpoch, inputSnapshotId: created.inputSnapshotId, state: "queued", executions: [], createdAt: 1 } };
}
async function succeed() { await act(async () => reply.resolve(creationReceipt())); }
let count = 0;
async function check(label: string, run: () => Promise<void>) {
  await run(); count++; console.log(`PASS ${count}: ${label}`);
}

async function main() {
  ({ createRoot } = await import("react-dom/client"));
  ({ useAppStore: store } = await import("../src/renderer/src/store/appStore"));
  ({ BotTeamDialog } = await import("../src/renderer/src/components/pages/BotTeamDialog"));
  initialState = store.getState();
  try {
    await check("form requires concrete goal, workspace, member responsibility and criteria", async () => {
      await reset(); assert.equal(submitButton().disabled, true); assert.deepEqual(requests, []);
      await fill(); assert.equal(submitButton().disabled, false);
      await edit(container.querySelector<HTMLTextAreaElement>(`#team-role-${other.botId}`)!, ""); assert.equal(submitButton().disabled, true);
    });
    await check("explicit submit uses existing read scope and does not send foreground messages", async () => {
      await reset(); await fill(); await submit(); assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].members[0].delegatedScope, ["workspace:read"]);
      assert.equal(requests[0].members[0].botId, other.botId); assert.equal(requests[0].ownerBotId, mybuddy.botId);
      assert.deepEqual(forbiddenCalls, []); assert.equal(store.getState().botDraft, "MyBuddy draft");
      await act(async () => form().dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true })));
      assert.equal(requests.length, 1, "repeated submit cannot dispatch twice");
    });
    await check("uncertain outcome, close and remount reuse the immutable operation", async () => {
      await reset(); await fill(); await submit(); const original = requests[0];
      await act(async () => reply.reject(new Error("connection lost"))); await close(); await unmount(); reply = deferred<WorkTeamControlResult>(); await mount();
      await submit(); assert.deepEqual(requests[1], original);
    });
    await check("legacy pending creation resolves its original operation without replaying a changed create request", async () => {
      await reset(); await fill(); await submit(); const original = requests[0]; const existing = creationReceipt();
      await act(async () => reply.reject(new Error("lost receipt"))); await unmount();
      const stored = JSON.stringify({ ...original, budgetTokens: 30000 }); values.set("mybuddy.pending-team-creation", stored);
      requests = []; await mount();
      assert.equal(container.querySelector("#team-budget"), null);
      await submit(); assert.deepEqual(lookupRequests, [original.operationId]); assert.deepEqual(requests, []);
      assert.equal(values.get("mybuddy.pending-team-creation"), stored, "lookup preserves the original uncertain request");
      await act(async () => lookupReply.reject(new Error("lookup lost")));
      assert.equal(values.get("mybuddy.pending-team-creation"), stored);
      lookupReply = deferred<WorkTeamControlResult>(); await submit();
      await act(async () => lookupReply.resolve({ ...existing, replayed: true }));
      assert.deepEqual(requests, []); assert.equal(store.getState().selectedWorkId, "new-team");
      assert.equal(values.has("mybuddy.pending-team-creation"), false);
    });
    await check("legacy pending creation needs another explicit click after a definitive missing receipt", async () => {
      await reset(); await fill(); await submit(); const original = requests[0];
      await act(async () => reply.reject(new Error("never received"))); await unmount();
      values.set("mybuddy.pending-team-creation", JSON.stringify({ ...original, budgetTokens: 30000 }));
      requests = []; await mount(); await submit();
      await act(async () => lookupReply.resolve({ ok: false, code: "not_found", message: "No creation" }));
      assert.equal(requests.length, 0); assert.equal(submitButton().textContent, "创建并开工");
      reply = deferred<WorkTeamControlResult>(); await submit();
      assert.equal(requests.length, 1); assert.equal(requests[0].operationId, original.operationId);
      assert.equal("budgetTokens" in requests[0], false); await succeed();
    });
    await check("closing before success never steals newer navigation", async () => {
      await reset(); await fill(); await submit(); await close();
      await act(async () => store.setState({ activeBotId: other.botId, selectedWorkId: null }));
      await succeed(); assert.equal(store.getState().activeBotId, other.botId); assert.equal(store.getState().selectedWorkId, null);
      await act(async () => openDialog!()); assert.match(container.textContent!, /已建立团队事项/);
    });
    await check("A to B to A navigation invalidates automatic result selection", async () => {
      await reset(); await fill(); await submit();
      await act(async () => { store.setState({ activeBotId: other.botId }); store.setState({ activeBotId: mybuddy.botId }); });
      await succeed(); assert.notEqual(store.getState().selectedWorkId, "new-team"); assert.match(container.textContent!, /查看团队事项/);
    });
    await check("definitive rejection unlocks editing; no success or auto-navigation is invented", async () => {
      await reset(); await fill(); await submit(); await act(async () => reply.resolve({ ok: false, code: "invalid_request", message: "Invalid workspace" }));
      assert.match(container.textContent!, /Invalid workspace/); assert.equal(Boolean(container.querySelector<HTMLFieldSetElement>("fieldset")!.disabled), false);
      assert.equal(store.getState().selectedWorkId, work.workId);
    });
    await check("storage failure prevents dispatch and preserves editable draft", async () => {
      await reset(); await fill(); const save = storage.setItem; storage.setItem = () => { throw Error("quota"); };
      try { await submit(); } finally { storage.setItem = save; }
      assert.equal(requests.length, 0); assert.match(container.textContent!, /无法保存请求/);
    });
    await check("fresh success selects the exact owner and persisted Work", async () => {
      await reset(); await fill();
      assert.equal(container.querySelector("#team-budget"), null, "team creation has no budget editor");
      assert.doesNotMatch(container.textContent!, /预算|额度/);
      await submit();
      assert.equal("budgetTokens" in requests[0], false, "team creation does not send a hidden budget");
      await succeed();
      assert.equal(store.getState().activeBotId, mybuddy.botId); assert.equal(store.getState().selectedWorkId, "new-team");
      assert.equal(store.getState().activeTaskId, "ordinary-task"); assert.equal(store.getState().botDraft, "MyBuddy draft");
    });
    await check("a confirmed team can be followed by a distinct new team", async () => {
      await reset(); await fill(); await submit(); await succeed(); await act(async () => openDialog!());
      const again = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "再建一队")!;
      await act(async () => nativeClick(again));
      assert.equal(container.querySelector<HTMLInputElement>("#team-title")!.value, ""); assert.equal(submitButton().disabled, true);
      for (const [id, value] of Object.entries({ "team-title": "Second project", "team-goal": "Second review", "team-criteria": "Sources checked" })) await edit(container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!, value);
      reply = deferred<WorkTeamControlResult>(); await submit(); assert.notEqual(requests[0].operationId, requests[1].operationId);
    });
    await check("templates save only explicit composition, never dispatch, and deletion requires a separate confirmation", async () => {
      await reset(); await fill(); await edit(container.querySelector<HTMLInputElement>("#team-template-name")!, "Review team");
      const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "保存团队模板")!;
      await act(async () => nativeClick(save)); assert.equal(templateCalls.length, 1); assert.equal(requests.length, 0);
      const saved = templateCalls[0]; assert.equal(saved.kind, "save_template"); if (saved.kind !== "save_template") throw Error("bad test");
      assert.equal("workspacePath" in saved.request.plan, false); assert.equal("budgetTokens" in saved.request.plan, false);
      const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "删除模板")!;
      await act(async () => nativeClick(remove)); assert.equal(templateCalls.length, 1);
      const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "确认删除")!;
      await act(async () => nativeClick(confirm)); assert.equal(templateCalls[1].kind, "delete_template"); assert.equal(requests.length, 0);
    });
    await check("participating members can browse Work without becoming its owner", async () => {
      const { botParticipatesInWork } = await import("../src/renderer/src/lib/botWorkspacePresentation");
      const projection = { ...work, team: { members: [{ botId: other.botId }] } } as unknown as WorkProjectionDto;
      assert.equal(botParticipatesInWork(projection, other.botId), true); assert.equal(botParticipatesInWork(projection, "unrelated"), false);
      assert.equal(botParticipatesInWork(work, other.botId), false); assert.equal(botParticipatesInWork(work, mybuddy.botId), true);
      assert.equal(projection.ownerBotId, mybuddy.botId);
    });
    await check("lost creation receipt reconciles the immutable operation after a rename and owner handoff", async () => {
      await reset(); await fill(); await submit(); const original = requests[0];
      await act(async () => reply.reject(new Error("lost receipt"))); reply = deferred<WorkTeamControlResult>(); await submit();
      assert.deepEqual(requests[1], original);
      await act(async () => reply.resolve({ ...creationReceipt({ title: "Renamed team", ownerBotId: other.botId, ownerEpoch: 2 }), replayed: true }));
      assert.match(container.textContent!, /Renamed team/); assert.doesNotMatch(container.textContent!, /回执与原请求不符/);
      assert.equal(store.getState().activeBotId, other.botId); assert.equal(store.getState().selectedWorkId, "new-team");
      assert.equal(values.has("mybuddy.pending-team-creation"), false);
    });
    await check("missing or wrong operation binding and inconsistent Work identity retain the original pending request", async () => {
      for (const mismatch of ["missing-operation", "wrong-operation", "wrong-work"] as const) {
        await reset(); await fill(); await submit(); const original = requests[0]; const receipt = creationReceipt();
        if (mismatch === "missing-operation") delete receipt.operationId;
        if (mismatch === "wrong-operation") receipt.operationId = "unrelated-operation";
        if (mismatch === "wrong-work") receipt.team = { ...receipt.team!, workId: "unrelated-work" };
        await act(async () => reply.resolve(receipt)); assert.match(container.textContent!, /回执与原请求不符/);
        assert.equal(store.getState().selectedWorkId, work.workId);
        assert.equal(JSON.parse(values.get("mybuddy.pending-team-creation")!).operationId, original.operationId);
        reply = deferred<WorkTeamControlResult>(); await submit(); assert.deepEqual(requests[1], original);
      }
    });
    await check("a selected member whose read grant was revoked can be removed but cannot be newly selected", async () => {
      await reset(); await fill();
      const revoked = { ...other, authorization: { ...other.authorization, allowedScopes: [] } };
      await act(async () => store.setState({ botIdentities: [mybuddy, revoked] }));
      assert.equal(submitButton().disabled, true);
      const checkbox = container.querySelector<HTMLInputElement>('.bot-team-member-toggle input')!;
      assert.equal(Boolean(checkbox.disabled), false, "revoked selected member remains removable");
      await act(async () => checkbox.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
      assert.equal(container.querySelector(`#team-role-${other.botId}`), null);
      assert.equal(container.querySelector<HTMLInputElement>('.bot-team-member-toggle input')!.disabled, true, "revoked unselected member cannot be added");
      assert.deepEqual(requests, []);
    });
    await check("parallel plan preserves concurrency, dependency and template settings", async () => {
      await reset(); await fill();
      const third = bot("third-bot", "Third assistant");
      await act(async () => store.setState({ botIdentities: [mybuddy, other, third] }));
      const select = async (id: string, value: string) => {
        const node = container.querySelector<HTMLSelectElement>(`#${id}`)!;
        await act(async () => { Object.defineProperty(node, "value", { configurable: true, value }); node.dispatchEvent(new testWindow.Event("change", { bubbles: true })); });
      };
      await select("team-execution-policy", "parallel"); await select("team-concurrency", "3");
      const thirdToggle = container.querySelectorAll<HTMLInputElement>('.bot-team-member-toggle input')[1];
      await act(async () => thirdToggle.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
      await edit(container.querySelector<HTMLTextAreaElement>("#team-role-third-bot")!, "Review first member evidence");
      const dependency = container.querySelector<HTMLInputElement>('fieldset[aria-label="Third assistant的前置成员"] input')!;
      await act(async () => { dependency.checked = true; dependency.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
      await edit(container.querySelector<HTMLInputElement>("#team-template-name")!, "Parallel plan");
      const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "保存团队模板")!;
      await act(async () => nativeClick(save));
      const saved = templateCalls[0]; assert.equal(saved.kind, "save_template"); if (saved.kind !== "save_template") throw Error("bad test");
      assert.equal(saved.request.plan.executionPolicy, "parallel"); assert.equal(saved.request.plan.maxConcurrency, 3);
      assert.deepEqual(saved.request.plan.members[1].dependsOnBotIds, [other.botId]);
      await select("team-execution-policy", "sequential"); await select("team-template", "template-a");
      assert.ok(container.querySelector("#team-concurrency"), "template restores parallel controls");
      await submit(); assert.equal(requests[0].executionPolicy, "parallel"); assert.equal(requests[0].maxConcurrency, 3);
      assert.deepEqual(requests[0].members[1].dependsOnBotIds, [other.botId]);
    });
    await check("removing a dependency member removes dangling references before submission", async () => {
      await reset(); await fill();
      const third = bot("third-bot", "Third assistant");
      await act(async () => store.setState({ botIdentities: [mybuddy, other, third] }));
      const policy = container.querySelector<HTMLSelectElement>("#team-execution-policy")!;
      await act(async () => { Object.defineProperty(policy, "value", { configurable: true, value: "parallel" }); policy.dispatchEvent(new testWindow.Event("change", { bubbles: true })); });
      await act(async () => container.querySelectorAll<HTMLInputElement>('.bot-team-member-toggle input')[1].dispatchEvent(new testWindow.Event("click", { bubbles: true })));
      await edit(container.querySelector<HTMLTextAreaElement>("#team-role-third-bot")!, "Independent inspection");
      const dependency = container.querySelector<HTMLInputElement>('fieldset[aria-label="Third assistant的前置成员"] input')!;
      await act(async () => { dependency.checked = true; dependency.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
      await act(async () => container.querySelector<HTMLInputElement>('.bot-team-member-toggle input')!.dispatchEvent(new testWindow.Event("click", { bubbles: true })));
      await submit(); assert.equal(requests[0].members.length, 1); assert.deepEqual(requests[0].members[0].dependsOnBotIds, []);
    });
    await testRecoveryControls();
    console.log(`PASS ${count} team UI behaviour checks`);
  } finally { await unmount(); }
}
async function testRecoveryControls() {
  const { BotTeamPanel } = await import("../src/renderer/src/components/pages/BotTeamPanel");
  const originalControl = api!.botWork.teamControl;
  let calls: WorkTeamControlRequest[] = [];
  let controlReply = deferred<WorkTeamControlResult>();
  const projection = (state: "blocked" | "superseded", patch: Partial<WorkProjectionDto> = {}): WorkProjectionDto => ({ ...work,
    team: { workId: work.workId, ownerBotId: mybuddy.botId, ownerResponsibility: "Review all evidence", intentRevision: 1, inputSnapshotId: "input", ownerEpoch: 1, state, createdAt: 1,
      members: [{ botId: other.botId, responsibility: "Inspect earlier effects", delegatedScope: ["workspace:read", "workspace:write"] }],
      executions: [{ botId: other.botId, responsibility: "Inspect earlier effects", delegatedScope: ["workspace:read", "workspace:write"], role: "member", taskId: "member-task", status: "blocked", error: "Setup unavailable" }] }, ...patch });
  const render = async (value: WorkProjectionDto) => { await act(async () => root!.render(<StrictMode><BotTeamPanel work={value} identities={[mybuddy, other]} /></StrictMode>)); };
  const start = async (value: WorkProjectionDto) => {
    await reset(); await unmount(); calls = []; controlReply = deferred<WorkTeamControlResult>();
    store.setState({ refreshBotWork: async () => {} });
    Object.assign(api!.botWork, { teamControl: async (request: WorkTeamControlRequest) => { calls.push(structuredClone(request)); return controlReply.promise; } });
    container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container); await render(value);
  };
  const button = (label: string) => { const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); assert.ok(node, `button: ${label}`); return node; };
  const confirm = async () => {
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(checkbox);
    // linkedom omits the browser's checkbox default action. Apply that native
    // state transition before dispatching the real click consumed by React.
    await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new testWindow.Event("click", { bubbles: true })); });
  };
  try {
    await check("team panel shows parallel policy, dependency and host waiting reason", async () => {
      const value = projection("blocked"); value.team!.executionPolicy = "parallel"; value.team!.maxConcurrency = 3;
      value.team!.executions[0].dependsOnBotIds = [mybuddy.botId]; value.team!.executions[0].waitingReason = "等待前置成员结算";
      await start(value); assert.match(container.textContent!, /按依赖并行（最多 3 位成员）/);
      assert.match(container.textContent!, /前置成员：MyBuddy/); assert.match(container.textContent!, /等待前置成员结算/);
    });
    await check("retry sends the exact current triple guard and not-started confirmation once", async () => {
      await start(projection("blocked", { stateVersion: 7, intentRevision: 3, ownerEpoch: 2 }));
      const retry = button("重试未启动的准备"); await act(async () => { nativeClick(retry); nativeClick(retry); });
      assert.deepEqual(calls, [{ kind: "retry", workId: work.workId, versionGuard: { expectedStateVersion: 7, expectedIntentRevision: 3, expectedOwnerEpoch: 2 }, confirmNotStarted: true }]);
      await act(async () => controlReply.resolve({ ok: false, code: "version_conflict", message: "Refresh required" }));
      const next = projection("blocked", { stateVersion: 9, intentRevision: 4, ownerEpoch: 3 }); await render(next); controlReply = deferred<WorkTeamControlResult>();
      await act(async () => nativeClick(button("重试未启动的准备")));
      assert.equal(calls[1].kind, "retry"); if (calls[1].kind === "retry") assert.deepEqual(calls[1].versionGuard, { expectedStateVersion: 9, expectedIntentRevision: 4, expectedOwnerEpoch: 3 });
    });
    await check("replan requires fresh explicit confirmation, preserves historical display and sends only read scopes", async () => {
      const before = projection("superseded"); await start(before);
      assert.equal(button("确认并只读复核").disabled, true); assert.match(container.textContent!, /原范围：工作区读写；本次仅只读/);
      await confirm(); assert.equal(button("确认并只读复核").disabled, false);
      await render(projection("superseded", { stateVersion: 2, intentRevision: 2, ownerEpoch: 2 })); assert.equal(button("确认并只读复核").disabled, true, "a newer projection invalidates old confirmation");
      await confirm(); await act(async () => nativeClick(button("确认并只读复核")));
      assert.equal(calls.length, 1); assert.equal(calls[0].kind, "replan"); if (calls[0].kind !== "replan") throw Error("bad test");
      assert.deepEqual(calls[0].versionGuard, { expectedStateVersion: 2, expectedIntentRevision: 2, expectedOwnerEpoch: 2 });
      assert.deepEqual(calls[0].plan.members[0].delegatedScope, ["workspace:read"]);
      assert.deepEqual(before.team!.members[0].delegatedScope, ["workspace:read", "workspace:write"], "historical projection remains immutable");
    });
    await check("owner handoff replan removes owner dependencies and previews the exact read-only plan", async () => {
      const value = projection("superseded", { ownerBotId: other.botId, ownerEpoch: 2 });
      value.team!.executionPolicy = "parallel"; value.team!.maxConcurrency = 2;
      value.team!.members.push({ botId: mybuddy.botId, responsibility: "Inspect after handoff", delegatedScope: ["workspace:read", "workspace:write"], dependsOnBotIds: [other.botId] });
      await start(value);
      assert.match(container.textContent!, /本次前置：无/); assert.match(container.textContent!, /依赖也从本次计划移除/);
      await confirm(); await act(async () => nativeClick(button("确认并只读复核")));
      assert.equal(calls[0].kind, "replan"); if (calls[0].kind !== "replan") throw Error("bad test");
      assert.equal(calls[0].plan.ownerBotId, other.botId); assert.equal(calls[0].plan.executionPolicy, "parallel");
      assert.equal(calls[0].plan.members.length, 1); assert.equal(calls[0].plan.members[0].botId, mybuddy.botId);
      assert.deepEqual(calls[0].plan.members[0].dependsOnBotIds, []); assert.deepEqual(calls[0].plan.members[0].delegatedScope, ["workspace:read"]);
      assert.deepEqual(value.team!.members[1].dependsOnBotIds, [other.botId], "historical plan is not mutated");
    });
    await check("late recovery receipt cannot display success for another Work or after A-B-A navigation", async () => {
      const original = projection("blocked"); await start(original); await act(async () => nativeClick(button("重试未启动的准备")));
      await render(projection("blocked", { workId: "other-work" }));
      await act(async () => controlReply.resolve({ ok: true })); assert.doesNotMatch(container.textContent!, /准备步骤已重新核对/);
      await start(original); await act(async () => nativeClick(button("重试未启动的准备")));
      await render(projection("blocked", { workId: "other-work" })); await render(original);
      await act(async () => controlReply.resolve({ ok: false, code: "late", message: "Stale Work A notice" })); assert.doesNotMatch(container.textContent!, /Stale Work A notice/);
    });
    await check("team panel shows automatic recovery progress and recovered state without claiming completion", async () => {
      const value = projection("blocked");
      value.team!.executions[0] = { ...value.team!.executions[0], status: "recovering", recoveryState: "pending",
        recoveryGeneration: 2, recoveryAttempts: 2, failureReason: "temporary provider failure" };
      await start(value);
      assert.match(container.textContent!, /自动恢复中/);
      assert.match(container.textContent!, /第 2 次/);
      assert.match(container.textContent!, /不重复已确认效果/);
      value.team!.executions[0] = { ...value.team!.executions[0], status: "recovered", recoveryState: "completed",
        recoveryOutcome: "completed", failureReason: "temporary provider failure" };
      await render(value);
      assert.match(container.textContent!, /已自动恢复/);
      assert.match(container.textContent!, /仍需负责人核对与用户验收/);
      assert.match(container.textContent!, /原失败：temporary provider failure/);
    });
    await check("terminal dependency failure is shown as unstarted without a retry approval", async () => {
      const value = projection("blocked");
      value.team!.executions[0] = { ...value.team!.executions[0], status: "blocked", error: undefined,
        notStartedReason: "未启动：前置成员自动恢复已停止", waitingReason: "未启动：前置成员自动恢复已停止" };
      await start(value);
      assert.match(container.textContent!, /未启动/);
      assert.match(container.textContent!, /前置成员自动恢复已停止/);
      assert.doesNotMatch(container.textContent!, /排队中/);
      assert.equal([...container.querySelectorAll("button")].some(item => item.textContent === "重试未启动的准备"), false);
      assert.deepEqual(calls, []);
    });
    await check("already-bound unknown execution does not expose a preparation retry", async () => {
      const value = projection("blocked"); value.team!.executions[0].bindingId = "original-binding"; value.team!.executions[0].status = "unknown";
      await start(value); assert.equal([...container.querySelectorAll("button")].some(item => item.textContent === "重试未启动的准备"), false); assert.deepEqual(calls, []);
    });
  } finally { Object.assign(api!.botWork, { teamControl: originalControl }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
