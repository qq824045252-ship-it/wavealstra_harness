/**
 * Real React input/click/submit/lifecycle tests with controlled host receipts.
 * linkedom supplies no layout, native form defaults or modal focus trapping;
 * those remain separate desktop acceptance checks, not claims of this suite.
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, StrictMode, useState } from "react";
import type { Root } from "react-dom/client";
import type { BotCreateRequest, BotCreateResult } from "../src/shared/bot-create";
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
const ordinaryDraft = { title: "Ordinary Task draft" };
let root: Root | undefined;
let container: HTMLElement;
let closeCalls = 0;
let requests: BotCreateRequest[] = [];
let forbiddenCalls: string[] = [];
let reply = deferred<BotCreateResult>();
let hostBots = [mybuddy, other];
let openDialog: (() => void) | undefined;
let store: typeof import("../src/renderer/src/store/appStore")["useAppStore"];
let initialState: AppState;
let createRoot: typeof import("react-dom/client")["createRoot"];
let BotCreateDialog: typeof import("../src/renderer/src/components/pages/BotCreateDialog")["BotCreateDialog"];
const api = { botWork: {
  createBot: async (request: BotCreateRequest) => { requests.push(structuredClone(request)); return reply.promise; },
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
  return <BotCreateDialog open={open} onClose={() => { closeCalls++; setOpen(false); }} />;
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
  await unmount(); values.clear(); requests = []; forbiddenCalls = []; closeCalls = 0;
  reply = deferred<BotCreateResult>(); hostBots = [mybuddy, other];
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
function nameField() {
  const node = form().querySelector<HTMLInputElement>("input");
  assert.ok(node, "creation has an editable name"); return node;
}
function summaryField() {
  const node = form().querySelector<HTMLTextAreaElement>("textarea");
  assert.ok(node, "creation has an editable responsibility summary"); return node;
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
async function fill(name = "Research assistant", summary = "Track research, ask before external actions.") {
  await edit(nameField(), name); await edit(summaryField(), summary);
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
function createdBot(request = requests.at(-1)!): BotDto {
  return bot("created-bot", request.displayName.trim(), (request.responsibilitySummary ?? "").trim());
}
async function succeed(replayed = false) {
  const created = createdBot(); hostBots = [mybuddy, other, created];
  await act(async () => reply.resolve({ ok: true, bot: created, replayed }));
  return created;
}
function assertOriginalContext() {
  assert.equal(store.getState().activeBotId, mybuddy.botId);
  assert.equal(store.getState().selectedWorkId, work.workId);
  assert.equal(store.getState().botDraft, "MyBuddy draft");
  assert.equal(store.getState().activeTaskId, "ordinary-task");
  assert.equal(store.getState().draft, ordinaryDraft);
  assert.deepEqual(store.getState().botWorks, [work]);
  assert.deepEqual(forbiddenCalls, [], "identity creation cannot dispatch conversation or Task work");
}
let count = 0;
async function check(label: string, run: () => Promise<void>) {
  await run(); count++; console.log(`PASS ${count}: ${label}`);
}

async function main() {
  // All renderer imports are intentionally after DOM initialization.
  ({ createRoot } = await import("react-dom/client"));
  ({ useAppStore: store } = await import("../src/renderer/src/store/appStore"));
  ({ BotCreateDialog } = await import("../src/renderer/src/components/pages/BotCreateDialog"));
  initialState = store.getState();
  try {
    await check("required name validation and optional configuration do not create messages, Tasks or Work", async () => {
      await reset(); assert.equal(submitButton().disabled, true);
      await edit(summaryField(), "Configuration only, not a message"); assert.equal(submitButton().disabled, true);
      await edit(nameField(), "   "); assert.equal(submitButton().disabled, true);
      await edit(nameField(), "A new Bot"); assert.equal(submitButton().disabled, false);
      await edit(summaryField(), ""); assert.equal(submitButton().disabled, false, "responsibility is optional");
      assert.equal(nameField().getAttribute("maxlength") ?? nameField().getAttribute("maxLength"), "80");
      assert.equal(summaryField().getAttribute("maxlength") ?? summaryField().getAttribute("maxLength"), "2000");
      assert.deepEqual(requests, []); assertOriginalContext();
    });
    await check("an existing name is disabled after trimming and case folding, including forced Enter submission", async () => {
      await reset(); await edit(nameField(), "  mYbUdDy  ");
      assert.equal(submitButton().disabled, true); assert.match(container.textContent!, /名称已经在使用/);
      await act(async () => form().dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true })));
      assert.deepEqual(requests, []); assertOriginalContext();
    });
    await check("a storage failure before dispatch is visible and cannot create an untraceable Bot", async () => {
      await reset(); await fill();
      const save = storage.setItem;
      storage.setItem = () => { throw new Error("Storage quota unavailable"); };
      try { await submit(); } finally { storage.setItem = save; }
      assert.deepEqual(requests, []); assertOriginalContext();
      assert.match(container.textContent!, /无法保存创建请求/);
      assert.equal(nameField().disabled, false); assert.equal(nameField().value, "Research assistant");
      await submit(); assert.equal(requests.length, 1);
    });
    await check("an unavailable host retains a retryable request and reconnect uses the original identity", async () => {
      await reset(); await fill();
      Object.defineProperty(testWindow, "api", { configurable: true, value: undefined });
      try { await submit(); } finally { Object.defineProperty(testWindow, "api", { configurable: true, value: api }); }
      assert.deepEqual(requests, []); assertOriginalContext(); assert.match(container.textContent!, /尚未连接创建接口/);
      assert.equal(nameField().disabled, true);
      const persisted = [...values.values()].map(value => JSON.parse(value)).find(value => value.requestId) as BotCreateRequest;
      assert.ok(persisted, "offline attempt retains an idempotency key before retry");
      await submit(); assert.deepEqual(requests[0], persisted); await succeed();
    });
    await check("repeated native submit events in one React turn produce only one unresolved host request", async () => {
      await reset(); await fill();
      const node = form(); const button = submitButton();
      await act(async () => {
        nativeClick(button); nativeClick(button);
        node.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
      });
      assert.equal(requests.length, 1); assert.equal(submitButton().disabled, true); assertOriginalContext();
      assert.match(requests[0].requestId, /^[\da-f-]{36}$/i);
    });
    await check("IME confirmation Enter is prevented, while an ordinary Enter remains a valid explicit submit", async () => {
      await reset(); await fill();
      for (const properties of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
        const event = new testWindow.Event("keydown", { bubbles: true, cancelable: true });
        Object.assign(event, { key: "Enter", ...properties });
        await act(async () => nameField().dispatchEvent(event));
        assert.equal(event.defaultPrevented, true, "React blocks the native form default while confirming IME text");
      }
      assert.deepEqual(requests, []); assertOriginalContext();
      const event = new testWindow.Event("keydown", { bubbles: true, cancelable: true });
      Object.assign(event, { key: "Enter", isComposing: false, keyCode: 13 });
      await act(async () => {
        nameField().dispatchEvent(event);
        assert.equal(event.defaultPrevented, false);
        form().dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
      });
      assert.equal(requests.length, 1);
    });
    await check("only a matching successful receipt selects the new Bot and preserves MyBuddy, Task and Work state", async () => {
      await reset(); await fill("  Research assistant  ", "  Track research.  "); await submit(); assertOriginalContext();
      const created = await succeed();
      assert.equal(store.getState().activeBotId, created.botId); assert.equal(store.getState().page, "bot");
      assert.equal(store.getState().selectedWorkId, null); assert.equal(store.getState().botDraft, "");
      assert.equal(store.getState().botDrafts[mybuddy.botId], "MyBuddy draft");
      assert.equal(store.getState().botDrafts[other.botId], "Other draft");
      assert.equal(store.getState().draft, ordinaryDraft); assert.equal(store.getState().activeTaskId, "ordinary-task");
      assert.equal(store.getState().tasks, initialState.tasks); assert.deepEqual(store.getState().botWorks, [work]);
      assert.equal(store.getState().botIdentities.filter(item => item.botId === created.botId).length, 1);
      assert.equal(store.getState().botHistories[mybuddy.botId].conversationId, "mybuddy-conversation");
      assert.deepEqual(forbiddenCalls, []); assert.equal(closeCalls, 1);
      assert.ok([...values.values()].some(value => value.includes(created.botId)), "new navigation is persisted");
      await act(async () => store.getState().setActiveBotId(mybuddy.botId));
      assert.equal(store.getState().botDraft, "MyBuddy draft", "returning to MyBuddy restores only its own draft");
    });
    await check("a definite rejection retains fields, leaves selection intact and permits a corrected new request", async () => {
      await reset(); await fill(); await submit();
      await act(async () => reply.resolve({ ok: false, code: "duplicate_name", message: "Choose a different Bot name" }));
      assert.equal(nameField().value, "Research assistant");
      assert.equal(summaryField().value, "Track research, ask before external actions.");
      assert.match(container.textContent!, /Choose a different Bot name/); assertOriginalContext();
      const original = requests[0]; reply = deferred<BotCreateResult>();
      await edit(nameField(), "Research assistant two"); await submit();
      assert.equal(requests.length, 2); assert.notEqual(requests[1].requestId, original.requestId);
      assert.equal(requests[1].displayName, "Research assistant two");
    });
    for (const failure of ["lost receipt", "storage_error"] as const) {
      await check(`${failure}: retry preserves the complete original request and cannot edit an uncertain creation`, async () => {
        await reset(); await fill(); await submit(); const original = requests[0];
        await act(async () => {
          if (failure === "lost receipt") reply.reject(new Error("Host committed but receipt was lost"));
          else reply.resolve({ ok: false, code: "storage_error", message: "Storage outcome is uncertain" });
        });
        assertOriginalContext(); assert.equal(nameField().value, original.displayName);
        assert.equal(nameField().disabled || nameField().readOnly, true);
        assert.equal(summaryField().disabled || summaryField().readOnly, true);
        reply = deferred<BotCreateResult>(); await submit();
        assert.deepEqual(requests[1], original); const created = await succeed(true);
        assert.equal(store.getState().activeBotId, created.botId);
        assert.equal(store.getState().botIdentities.filter(item => item.botId === created.botId).length, 1);
      });
    }
    for (const code of ["not_authority", "forbidden"] as const) {
      await check(`lost receipt followed by ${code} keeps the frozen request through remount and recovers with the same UUID`, async () => {
        await reset(); await fill(); await submit(); const original = requests[0];
        await act(async () => reply.reject(new Error("Host committed but its acknowledgement was lost")));
        reply = deferred<BotCreateResult>(); await submit();
        assert.deepEqual(requests[1], original);
        const message = `Retry temporarily refused: ${code}`;
        await act(async () => reply.resolve({ ok: false, code, message }));
        assertOriginalContext(); assert.match(container.textContent!, new RegExp(message));
        assert.equal(nameField().value, original.displayName);
        assert.equal(summaryField().value, original.responsibilitySummary);
        assert.equal(nameField().disabled || nameField().readOnly, true);
        assert.equal(summaryField().disabled || summaryField().readOnly, true);
        const saved = [...values.values()].map(value => JSON.parse(value)).find(value => value.requestId) as BotCreateRequest;
        assert.deepEqual(saved, original, "a transient permission or lease refusal cannot disprove the earlier commit");
        await unmount(); reply = deferred<BotCreateResult>(); await mount();
        assert.equal(requests.length, 2, "restoring a refused retry does not implicitly resubmit it");
        assert.equal(nameField().disabled || nameField().readOnly, true);
        assert.equal(summaryField().disabled || summaryField().readOnly, true);
        await submit(); assert.deepEqual(requests[2], original);
        assert.equal(new Set(requests.map(request => request.requestId)).size, 1);
        const created = await succeed(true);
        assert.equal(store.getState().activeBotId, created.botId);
        assert.equal(store.getState().botIdentities.filter(item => item.botId === created.botId).length, 1);
        assert.equal(closeCalls, 1); assert.deepEqual(forbiddenCalls, []);
        assert.equal([...values.values()].some(value => value.includes(original.requestId)), false,
          "only the accepted replay clears the original pending request");
      });
    }
    await check("remount restores an unconfirmed request with the same identity and does not silently resubmit it", async () => {
      await reset(); await fill(); await submit(); const original = requests[0];
      await act(async () => reply.reject(new Error("Acknowledgement lost")));
      await unmount(); reply = deferred<BotCreateResult>(); await mount();
      assert.equal(requests.length, 1); assert.equal(nameField().value, original.displayName);
      assert.equal(summaryField().value, original.responsibilitySummary);
      await submit(); assert.deepEqual(requests[1], original);
      await succeed(true);
      await unmount(); await mount();
      assert.equal(nameField().value, "", "a confirmed receipt clears the stored pending request");
      assert.equal(requests.length, 2);
    });
    for (const dismissal of ["close", "Escape"] as const) {
      await check(`${dismissal} while pending: late success registers the Bot without changing the user's selection`, async () => {
        await reset(); await fill(); await submit();
        if (dismissal === "close") await close();
        else {
          const dialog = container.querySelector("dialog"); assert.ok(dialog);
          await act(async () => dialog.dispatchEvent(new testWindow.Event("cancel", { bubbles: false, cancelable: true })));
        }
        assert.equal(closeCalls, 1); const created = await succeed(); assertOriginalContext();
        assert.equal(closeCalls, 1); assert.ok(store.getState().botIdentities.some(item => item.botId === created.botId));
      });
    }
    await check("close and reopen cannot let an earlier pending request close or navigate the newer dialog", async () => {
      await reset(); await fill(); await submit(); await close();
      await act(async () => openDialog!()); await succeed(); assertOriginalContext();
      assert.equal(closeCalls, 1); assert.ok(container.querySelector("dialog[open]"));
    });
    await check("a Bot completed after dismissal is opened only by a new explicit click", async () => {
      await reset(); await fill(); await submit(); await close(); const created = await succeed();
      await act(async () => openDialog!()); assertOriginalContext();
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "打开 Bot");
      assert.ok(button); await act(async () => nativeClick(button));
      assert.equal(store.getState().activeBotId, created.botId); assert.equal(store.getState().page, "bot");
      assert.equal(store.getState().selectedWorkId, null); assert.equal(closeCalls, 2);
    });
    await check("unmount and remount isolate a late failure from the new form while preserving the retry identity", async () => {
      await reset(); await fill(); await submit(); const original = requests[0]; const previousReply = reply;
      await unmount(); await mount();
      await act(async () => previousReply.reject(new Error("Failure belongs to the old component")));
      assert.doesNotMatch(container.textContent!, /Failure belongs to the old component/);
      assertOriginalContext(); reply = deferred<BotCreateResult>(); await submit(); assert.deepEqual(requests[1], original);
    });
    const navigations: Array<[string, () => void]> = [
      ["another page", () => store.getState().setPage("chat")],
      ["another Bot", () => store.getState().setActiveBotId(other.botId)],
      ["another Work", () => store.getState().setSelectedWorkId(null)],
      ["Bot A to B to A", () => { store.getState().setActiveBotId(other.botId); store.getState().setActiveBotId(mybuddy.botId); }],
      ["page away and back", () => { store.getState().setPage("chat"); store.getState().setPage("bot"); }],
      ["another ordinary Task", () => store.setState({ activeTaskId: "newer-ordinary-task" })],
    ];
    for (const [label, navigate] of navigations) await check(`newer navigation (${label}) wins over the late creation receipt`, async () => {
      await reset(); await fill(); await submit(); await act(async () => navigate());
      const latest = store.getState(); const expected = [latest.page, latest.activeBotId, latest.selectedWorkId, latest.botDraft];
      await succeed(); const actual = store.getState();
      assert.deepEqual([actual.page, actual.activeBotId, actual.selectedWorkId, actual.botDraft], expected);
      assert.equal(closeCalls, 0); assert.equal(actual.draft, ordinaryDraft); assert.deepEqual(forbiddenCalls, []);
    });
    await check("a mismatched receipt is not accepted or selected and retry retains its original request", async () => {
      await reset(); await fill(); await submit(); const original = requests[0];
      await act(async () => reply.resolve({ ok: true, bot: bot("wrong-bot", "Wrong name"), replayed: false }));
      assertOriginalContext(); assert.equal(store.getState().botIdentities.some(item => item.botId === "wrong-bot"), false);
      reply = deferred<BotCreateResult>(); await submit(); assert.deepEqual(requests[1], original);
    });
    await testStoreRefreshRace();
    await testWorkspaceGrant();
    await testEntries();
  } finally {
    await unmount(); store.setState(initialState, true); values.clear();
  }
  console.log(`PASS Bot creation UI: ${count} real React lifecycle/event and store checks; desktop focus/layout are separate.`);
}

async function testStoreRefreshRace() {
  await check("store-only creation does not navigate, and a pre-creation list refresh cannot erase the committed Bot", async () => {
    await unmount();
    const { createAppStore } = await import("../src/renderer/src/store/app/createAppStore");
    const oldList = deferred<BotDto[]>(); const oldWorks = deferred<WorkListUpdate>();
    const request: BotCreateRequest = { requestId: "3b211b12-d066-4692-8f5e-59e522f13051", displayName: "Created independently", responsibilitySummary: "" };
    const created = createdBot(request);
    const isolatedApi = { botWork: { ...api!.botWork,
      listBots: () => oldList.promise, syncWorks: () => oldWorks.promise,
      createBot: async (): Promise<BotCreateResult> => ({ ok: true, bot: created, replayed: false }),
    } } as unknown as Window["api"];
    const isolated = createAppStore({ getApi: () => isolatedApi }).useAppStore;
    isolated.setState({ page: "bot", activeBotId: mybuddy.botId, selectedWorkId: work.workId,
      botIdentities: [mybuddy], botIdentitiesLoaded: true, botWorks: [work], botDraft: "MyBuddy draft",
      botDrafts: { [mybuddy.botId]: "MyBuddy draft" } });
    const stale = isolated.getState().refreshBotWork();
    await isolated.getState().createBot(request);
    assert.equal(isolated.getState().activeBotId, mybuddy.botId);
    assert.equal(isolated.getState().selectedWorkId, work.workId);
    isolated.getState().setActiveBotId(created.botId);
    oldList.resolve([mybuddy]);
    oldWorks.resolve({ kind: "snapshot", cursor: { epoch: "stale", sequence: 1, scope: "open" }, works: [work] });
    await stale;
    assert.equal(isolated.getState().activeBotId, created.botId); assert.equal(isolated.getState().page, "bot");
    assert.ok(isolated.getState().botIdentities.some(item => item.botId === created.botId));
  });
}

async function toggleCheckbox(input: HTMLInputElement, checked: boolean) {
  await act(async () => {
    input.checked = checked;
    input.dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
}
async function testWorkspaceGrant() {
  await check("explicit creation grant is saved with the immutable retry request", async () => {
    await reset(); await fill("Writable helper");
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(Boolean(checkbox.checked), false);
    await toggleCheckbox(checkbox, true);
    await submit();
    assert.equal(requests[0].allowWorkspaceFiles, true);
    assert.equal(checkbox.disabled, true);
    assert.equal(JSON.parse(storage.getItem("mybuddy.pending-bot-creation")!).allowWorkspaceFiles, true);
    await succeed();
  });
  await check("settings grant requires confirmation, uses version guard and never mutates old Work", async () => {
    await reset(); await unmount();
    const { BotWorkspaceAuthorization } = await import("../src/renderer/src/components/pages/BotWorkspaceAuthorization");
    const saved: unknown[] = [];
    api!.botWork.updateWorkspaceAuthorization = async request => {
      saved.push(request); return { ok: true, bot: mybuddy, replayed: false };
    };
    container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
    await act(async () => root!.render(<BotWorkspaceAuthorization bot={mybuddy} />));
    assert.match(container.textContent!, /已有事项/);
    await toggleCheckbox(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!, true);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    assert.equal(button.disabled, true);
    await toggleCheckbox(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1], true);
    assert.equal(button.disabled, false);
    await act(async () => nativeClick(button));
    assert.deepEqual(saved, [{ botId: mybuddy.botId, expectedUpdatedAt: mybuddy.updatedAt,
      allowWorkspaceFiles: true, confirmNewWorksOnly: true }]);
    assert.deepEqual(store.getState().botWorks, [work]);
    assert.deepEqual(forbiddenCalls, []);
  });
}

async function testEntries() {
  await check("Sidebar and first-use empty state expose working create buttons without sending a message", async () => {
    await reset(); await unmount();
    const { default: Sidebar } = await import("../src/renderer/src/components/Sidebar");
    const { default: BotWorkspacePage } = await import("../src/renderer/src/components/pages/BotWorkspacePage");
    store.setState({ activeBotId: null, selectedWorkId: null, botIdentities: [], botWorks: [], botDraft: "",
      refreshBotWork: async () => {}, refreshBotHistory: async () => {} });
    let opens = 0;
    container = testDocument.body.appendChild(testDocument.createElement("div")); root = createRoot(container);
    await act(async () => root!.render(<StrictMode><Sidebar onCreateBot={() => { opens++; }} />
      <BotWorkspacePage onCreateBot={() => { opens++; }} /></StrictMode>));
    assert.match(container.textContent!, /还没有 Bot/);
    assert.doesNotMatch(container.textContent!, /受理服务尚未接线/);
    const sidebar = container.querySelector('[aria-label="Bot 导航"]'); assert.ok(sidebar);
    const sidebarCreate = [...sidebar.querySelectorAll<HTMLButtonElement>("button")].find(button => /(?:创建|新建) Bot/.test(button.getAttribute("aria-label") ?? button.textContent ?? ""));
    assert.ok(sidebarCreate, "empty sidebar exposes the create action");
    const empty = container.querySelector(".bot-conversation-empty"); assert.ok(empty);
    const emptyCreate = [...empty.querySelectorAll<HTMLButtonElement>("button")].find(button => /创建/.test(button.textContent ?? ""));
    assert.ok(emptyCreate, "first-use empty state provides a useful create action");
    await act(async () => { nativeClick(sidebarCreate); nativeClick(emptyCreate); });
    assert.equal(opens, 2); assert.deepEqual(requests, []); assert.deepEqual(forbiddenCalls, []);
  });
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
