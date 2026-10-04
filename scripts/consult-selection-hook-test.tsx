import { act } from "react";
import { createRoot } from "react-dom/client";
import { useConsultSelection } from "../src/renderer/src/components/chat/useConsultSelection";
import { consultEntryReadiness } from "../src/shared/consult-entry";

const w = window as any;
w.IS_REACT_ACT_ENVIRONMENT = true;
const good = { enabled: true, participants: [{ modelId: "p/a" }, { modelId: "p/b" }] };
let read: () => Promise<any> = async () => ({ config: { multiModelConsult: good } });
let opens = 0, focuses = 0;
w.api = { agent: { getBuiltinCapabilities: () => read() } };
let options = { taskId: "a" as string | null, externalAgentId: undefined as string | undefined, settingsOpen: false,
  openSettings: () => { opens++; }, focusComposer: () => { focuses++; } };
let control!: ReturnType<typeof useConsultSelection>;
function Harness() { control = useConsultSelection(options); return null; }
const node = document.createElement("div");document.body.append(node);const root = createRoot(node);
const render = async () => { await act(async () => { root.render(<Harness />); }); };
const check = (ok: unknown, detail: string) => { if (!ok) throw new Error(detail); };
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; });return { promise, resolve }; };
const result: { tests: Array<{ name: string; passed: boolean; error?: string }>; passed?: boolean } = { tests: [] };
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn();result.tests.push({ name, passed: true }); }
  catch (e) { result.tests.push({ name, passed: false, error: String(e) }); }
}
w.__consultRun = (async () => {
  await render();
  await test("valid saved configuration selects without navigation", async () => {
    await act(async () => { await control.select(); });
    check(control.requested && !control.notice && opens === 0 && focuses === 1, "Ready config did not select directly");
  });
  await test("disabled configuration is an inline notice, not a redirect", async () => {
    read = async () => ({ config: { multiModelConsult: { ...good, enabled: false } } });
    await act(async () => { await control.select(); });
    check(!control.requested && control.needsConfiguration && opens === 0, "Disabled config navigated");
  });
  await test("missing IPC result is a read error, not missing configuration", async () => {
    read = async () => undefined;
    await act(async () => { await control.select(); });
    check(!control.requested && !control.needsConfiguration && !!control.notice && opens === 0, "Read failure confused with setup");
  });
  await test("saving during explicit setup resumes selection after returning", async () => {
    await act(async () => { control.openConfiguration(); });
    options = { ...options, settingsOpen: true };await render();
    read = async () => ({ config: { multiModelConsult: good } });
    options = { ...options, settingsOpen: false };await render();
    check(control.requested && opens === 1, "Saved setup did not resume exactly once");
  });
  await test("closing unsaved setup does not select or reopen settings", async () => {
    read = async () => ({ config: { multiModelConsult: { ...good, enabled: false } } });
    await act(async () => { control.clear();control.openConfiguration(); });
    options = { ...options, settingsOpen: true };await render();
    options = { ...options, settingsOpen: false };await render();
    check(!control.requested && control.needsConfiguration && opens === 2, "Unsaved setup reopened settings or became selected");
  });
  await test("late result cannot select a different task", async () => {
    const d = deferred();read = () => d.promise;let run!: Promise<void>;
    await act(async () => { run = control.select(); });
    options = { ...options, taskId: "b" };await render();
    await act(async () => { d.resolve({ config: { multiModelConsult: good } });await run; });
    check(!control.requested && !control.notice, "Old task result leaked");
  });
  await test("stale unavailable response cannot replace a newer successful selection", async () => {
    const d = deferred();read = () => d.promise;let old!: Promise<void>;
    await act(async () => { old = control.select(); });
    read = async () => ({ config: { multiModelConsult: good } });await act(async () => { await control.select(); });
    await act(async () => { d.resolve({ config: { multiModelConsult: { ...good, enabled: false } } });await old; });
    check(control.requested && !control.notice && !control.needsConfiguration && opens === 2, "Stale response replaced current selection");
  });
  await test("removing selection invalidates a pending read", async () => {
    const d = deferred();read = () => d.promise;let run!: Promise<void>;
    await act(async () => { run = control.select();control.clear(); });
    await act(async () => { d.resolve({ config: { multiModelConsult: good } });await run; });
    check(!control.requested, "Removed selection returned");
  });
  await test("external agent switch discards pending consultation", async () => {
    const d = deferred();read = () => d.promise;let run!: Promise<void>;
    await act(async () => { run = control.select(); });
    options = { ...options, externalAgentId: "external" };await render();
    await act(async () => { d.resolve({ config: { multiModelConsult: good } });await run;await control.select(); });
    check(!control.requested && !!control.notice && opens === 2, "External agent acquired consultation or caused navigation");
  });
  await test("readiness counts distinct configured models and rejects absent data", () => {
    check(!consultEntryReadiness({ enabled: true, participants: [{ modelId: "p/a" }, { modelId: " p/a " }] }).ready, "Duplicate models were accepted");
    for (const bad of [null, undefined, {}, { enabled: true, participants: null }]) {
      let threw = false;try { consultEntryReadiness(bad); } catch { threw = true; }check(threw, "Invalid API response was accepted");
    }
  });
  await test("unmount discards in-flight callbacks", async () => {
    options = { ...options, externalAgentId: undefined };await render();
    const d = deferred();read = () => d.promise;let run!: Promise<void>;const before = focuses;
    await act(async () => { run = control.select();root.unmount(); });
    await act(async () => { d.resolve({ config: { multiModelConsult: good } });await run; });
    check(focuses === before && opens === 2, "Unmounted input handled a late result");
  });
  result.passed = result.tests.every(t => t.passed);
  return result;
})();
