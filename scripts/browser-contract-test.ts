import assert from "node:assert/strict";
import { BrowserAutomationService, BrowserAutomationError } from "../src/main/capabilities/BrowserAutomationService";
import type { BrowserHost } from "../src/main/browser/BrowserHost";
import { AutomationScope, AutomationTimeoutError } from "../src/main/capabilities/AutomationScope";
import { PageInspectionSession } from "../src/main/artifact/PageInspectionService";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const navigations: ReturnType<typeof deferred<void>>[] = [];
  const pages = ["a", "b"].map((id, index) => ({
    id, captureVersion: 0, url: `https://fixture.test/${id}`,
    withAutomationSurface: async <T>(operation: () => Promise<T>) => operation(),
    inspectionWebContents: {
      id: index + 1, isDestroyed: () => false, getURL: () => `https://fixture.test/${id}`,
      getTitle: () => id, executeJavaScript: async (_script: string): Promise<unknown> => new Promise(() => {}),
    },
    navigateForAutomation: async () => { const pending = deferred<void>(); navigations.push(pending); await pending.promise; },
  }));
  const host = {
    attached: true, listTabs: () => pages.map(page => ({ id: page.id, taskId: "task", url: page.url })),
    getTabHost: (id: string) => pages.find(page => page.id === id) ?? null,
  } as unknown as BrowserHost;
  return { service: new BrowserAutomationService(() => host), pages, navigations };
}

const checks: string[] = [];
{
  const scope = new AutomationScope(undefined, 100);
  await scope.run(() => delay(60));
  await assert.rejects(scope.run(() => delay(60)), error => error instanceof AutomationTimeoutError);
  scope.close(); checks.push("one absolute deadline across awaits");
}
{
  const { service, pages } = fixture();
  const abort = new AbortController();
  let started!: () => void;
  const inRenderer = new Promise<void>(resolve => { started = resolve; });
  pages[0].inspectionWebContents.executeJavaScript = async () => { started(); return new Promise(() => {}); };
  const pending = service.execute({ action: "read", tabId: "a" }, abort.signal, { taskId: "task" });
  const result = pending.then(() => "resolved", error => error.name);
  await inRenderer;
  abort.abort();
  assert.equal(await Promise.race([result, delay(250).then(() => "pending")]), "AbortError", "read must stop waiting for renderer JS");
  checks.push("pending read cancellation");
}
{
  const { service, pages } = fixture();
  let entered!: () => void;
  const inRead = new Promise<void>(resolve => { entered = resolve; });
  pages[0].inspectionWebContents.executeJavaScript = async script => {
    if (script.includes("const snapshot=state.snapshot")) { entered(); return new Promise(() => {}); }
    return true;
  };
  const abort = new AbortController();
  const reading = service.execute({ action: "read", tabId: "a" }, abort.signal, { taskId: "task" });
  const result = reading.catch(error => error);
  await inRead; abort.abort(); assert.equal((await result).name, "AbortError");
  checks.push("atomic text/title/targets read cancellation after renderer dispatch");
}
{
  const abort = new AbortController();
  let active = 0;
  const add = abort.signal.addEventListener.bind(abort.signal), remove = abort.signal.removeEventListener.bind(abort.signal);
  Object.defineProperties(abort.signal, { addEventListener: { value: (...args: Parameters<typeof add>) => { active++; return add(...args); } }, removeEventListener: { value: (...args: Parameters<typeof remove>) => { active--; return remove(...args); } } });
  const scope = new AutomationScope(abort.signal);
  let sum = 0;
  for (let index = 1; index <= 100; index++) sum += await scope.run(async () => index);
  assert.equal(sum, 5050); assert.equal(active, 0); scope.close();
  checks.push("successful repeated waits release Abort listeners");
}
{
  const { service, navigations } = fixture();
  const a = service.execute({ action: "navigate", tabId: "a", url: "https://fixture.test/new-a" }, undefined, { taskId: "task" });
  const b = service.execute({ action: "navigate", tabId: "b", url: "https://fixture.test/new-b" }, undefined, { taskId: "task" });
  await delay(0);
  for (const pending of navigations) pending.resolve();
  const results = await Promise.allSettled([a, b]);
  assert(results.every(result => result.status === "fulfilled"), "independent tabs must not replace each other's navigation");
  checks.push("independent navigation receipts");
}
{
  const { service, navigations } = fixture();
  const a = service.execute({ action: "navigate", tabId: "a", url: "https://fixture.test/old" }, undefined, { taskId: "task" });
  const aResult = a.catch(error => error);
  const b = service.execute({ action: "navigate", tabId: "a", url: "https://fixture.test/new" }, undefined, { taskId: "task" });
  await delay(0);
  navigations[1].resolve(); await b;
  navigations[0].resolve();
  const error = await aResult;
  assert(error instanceof BrowserAutomationError && error.code === "SURFACE_CHANGED");
  checks.push("same-tab latest navigation wins");
}
{
  const { service, pages } = fixture();
  const pending = deferred<unknown>();
  let inputs = 0, pendingStarted!: () => void;
  const started = new Promise<void>(resolve => { pendingStarted = resolve; });
  const element = { selector: '[data-mybuddy-ui-ref="test-ref"]', id: "field", tag: "input", name: "Field", visible: true, disabled: false, bounds: { x: 1, y: 1, width: 20, height: 20 } };
  const page = pages[0];
  page.inspectionWebContents.executeJavaScript = async script => {
    if (script.includes("const snapshot=state.snapshot")) return { documentId: "doc", text: "Field", elements: [{ ...element, label: "Field" }] };
    if (script.includes("?.documentId")) return "doc";
    if (script.includes("const q=")) return { ok: true, matches: [element] };
    if (script.includes("const hit=document.elementFromPoint")) return { x: 10, y: 10 };
    if (script.includes("return el?{tag:")) return { tag: "input", name: "Field" };
    return true;
  };
  let attached = false;
  Object.assign(page.inspectionWebContents, { debugger: {
    isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; }, on: () => {}, off: () => {},
    sendCommand: async (method: string) => { if (method === "Input.insertText") { pendingStarted(); return pending.promise; } if (method.startsWith("Input.")) inputs++; return {}; },
  } });
  await service.execute({ action: "read", tabId: "a" }, undefined, { taskId: "task" });
  const abort = new AbortController();
  const filling = service.execute({ action: "fill", tabId: "a", selector: "#field", text: "Value" }, abort.signal, { taskId: "task" });
  const captured = filling.catch(error => error);
  await started; abort.abort();
  const error = await captured;
  assert.equal(error.name, "AbortError"); assert.equal(error.details.outcome.dispatch, "dispatched"); assert.equal(error.details.outcome.effect, "unknown");
  const count = inputs; pending.resolve(undefined); await delay(10); assert.equal(inputs, count, "late renderer receipt cannot dispatch the next step");
  checks.push("cancel after input dispatch retains unknown effect and ignores late receipt");
}
{
  const receipt = deferred<unknown>(), entered = deferred<void>(), commands: string[] = [];
  const session = new PageInspectionSession("contract-inspector-restore");
  await session.attach({ attach: () => {}, detach: () => {}, isAttached: () => false, on: () => {}, off: () => {},
    sendCommand: async method => { commands.push(method); if (method === "Overlay.disable") { entered.resolve(); return receipt.promise; } return {}; },
  });
  const abort = new AbortController(), scope = new AutomationScope(abort.signal);
  const pending = scope.run(() => session.suspendInputOverlay(() => scope.check())).catch(error => error);
  await entered.promise; abort.abort(); assert.equal((await pending).name, "AbortError");
  await session.setInspectMode();
  assert.deepEqual(commands.slice(-2), ["Overlay.enable", "Overlay.setInspectMode"], "restore must enable Overlay even while the cancelled disable receipt is pending");
  receipt.resolve({}); await delay(10); assert(session.inspectMode);
  assert(session.isAttached, "cancellation preserves the existing debugger owner");
  scope.close(); session.dispose(); checks.push("cancelled Overlay disable preserves inspector restoration");
}
console.log("browser contract: PASS", checks);
