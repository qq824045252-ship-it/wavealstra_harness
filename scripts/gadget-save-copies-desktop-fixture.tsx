/** Renderer-only Electron fixture: real GadgetMoveDialog, mocked API/store, no app bootstrap. */
import React from "react";
import { createRoot } from "react-dom/client";
import GadgetSection from "../src/renderer/src/components/gadget/GadgetSection";
import GadgetMoveDialog from "../src/renderer/src/components/gadget/GadgetMoveDialog";

const state: any = { tasks: [{ id: "task", spaceId: "space" }], spaces: [{ id: "space", name: "Fixture space" }], setGadgetsCount: () => {} };
// This module is also the esbuild alias for appStore; no real store or credentials are loaded.
export const useAppStore = Object.assign((selector: (value: any) => unknown): any => selector(state), { getState: () => state });
const root = createRoot(document.getElementById("root")!);
const gadget: any = { id: "source", name: "Original", scope: { type: "task", taskId: "task" }, runtime: { status: "stopped" } };
let listedGadget = gadget;
const wait = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30));
const assert = (ok: unknown, message: string): void => { if (!ok) throw Error(message); };
let closed = 0;
let done = 0;
let requests: any[] = [];
let resolveSave: (() => void) | undefined;
let rejectSave: ((error: Error) => void) | undefined;
(window as any).api = { gadget: {
  list: async () => [listedGadget],
  onChanged: () => () => {},
  copyScope: (request: unknown) => { requests.push({ route: "copy", request }); return new Promise<void>((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }); },
  moveScope: (request: unknown) => { requests.push({ route: "move", request }); return new Promise<void>((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }); },
} };
async function mount(mode: "copy" | "move"): Promise<void> {
  root.render(null); await wait();
  root.render(<GadgetMoveDialog mode={mode} gadget={gadget} initialTarget="workspace" onClose={() => closed++} onMoved={() => done++} />);
  await wait();
}
function submit(): HTMLButtonElement { return document.querySelector("footer .btn--primary") as HTMLButtonElement; }
async function main(): Promise<void> {
  const results: string[] = [];
  await mount("copy");
  assert(document.body.textContent?.includes("原工具保留"), "Copy must explain original retention");
  const first = submit(); first.click(); first.click(); await wait();
  assert(requests.length === 1 && requests[0].route === "copy", "Double click must dispatch one copy, never move");
  assert(requests[0].request.scope.workspaceId === "space", "Copy defaults to source task workspace");
  assert(submit().disabled, "Pending save disables submit");
  resolveSave!(); await wait();
  assert(done === 1, "Successful copy reports completion once");
  results.push("copy route, source workspace, duplicate click and busy state");

  await mount("move");
  assert(submit().textContent === "移动", "Explicit move remains labeled move");
  submit().click(); await wait();
  assert(requests.at(-1).route === "move", "Explicit move dispatches move only");
  resolveSave!(); await wait();
  results.push("explicit move uses moveScope");

  await mount("copy");
  submit().click(); await wait();
  rejectSave!(Error("Fixture write failed")); await wait();
  assert(document.querySelector('[role="alert"]')?.textContent === "Fixture write failed", "Rejected save must show error");
  assert(!submit().disabled, "Rejected save can retry");
  const beforeRetry = requests.length; submit().click(); await wait();
  assert(requests.length === beforeRetry + 1, "Retry dispatches one fresh request");
  resolveSave!(); await wait();
  results.push("rejected save stays open and retry succeeds");

  await mount("copy");
  submit().click(); await wait();
  const beforeDone = done;
  // Parent navigation unmounts the dialog; late completion must not affect the new view.
  root.render(<div data-view="other">Other task</div>); await wait();
  resolveSave!(); await wait();
  assert(done === beforeDone, "Late completion cannot call old parent callback");
  assert(document.querySelector('[data-view="other"]'), "Navigation survives delayed completion");
  assert(closed === 0, "No incidental close callback");
  results.push("navigation while save pending ignores stale completion");
  // Exercise the actual section menu, not a copied menu or source-text assertion.
  async function section(type: "task" | "workspace" | "global"): Promise<void> {
    root.render(null); await wait();
    const scope: any = type === "task" ? { type, taskId: "task" } : type === "workspace" ? { type, workspaceId: "space" } : { type };
    listedGadget = { ...gadget, scope };
    root.render(<GadgetSection scope={scope} />);
    for (let i = 0; i < 100 && !document.querySelector(".gadget-more-btn"); i++) await wait();
    assert(document.querySelector(".gadget-more-btn"), "Section must render actual tool card");
    (document.querySelector(".gadget-more-btn") as HTMLElement).click(); await wait();
  }
  const menuButtons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>(".gadget-action-menu-popover button")];
  const action = (text: string): HTMLButtonElement => {
    const button = menuButtons().find(item => item.textContent?.trim() === text);
    assert(button, `Missing menu action: ${text}`); return button!;
  };
  for (const type of ["task", "workspace", "global"] as const) {
    await section(type);
    const labels = menuButtons().map(item => item.textContent?.trim());
    assert(labels.filter(label => label === "保存到工作空间").length === 1, `${type}: exactly one workspace-copy action`);
    assert(labels.filter(label => label === "保存到我的工作台").length === (type === "global" ? 0 : 1), `${type}: personal-copy action without duplicate`);
    assert(!labels.some(label => label?.includes("任务工作目录") || label?.includes("移动")), `${type}: no directory-export or move menu`);
    if (type !== "global") {
      const before = requests.length;
      action("保存到我的工作台").click(); await wait();
      assert(requests.length === before + 1 && requests.at(-1).route === "copy" && requests.at(-1).request.scope.type === "global", `${type}: personal menu creates copy`);
      resolveSave!(); await wait();
      assert(document.querySelector(".gadget-card-name")?.textContent === "Original", "Copy leaves original rendered");
    }
  }
  await section("task");
  action("保存到工作空间").click(); await wait();
  assert(document.querySelector('[aria-label="保存 Gadget 副本"]'), "Workspace menu opens copy dialog");
  const beforeWorkspace = requests.length;
  submit().click(); await wait();
  assert(requests.length === beforeWorkspace + 1 && requests.at(-1).route === "copy" && requests.at(-1).request.scope.workspaceId === "space", "Section workspace save copies to selected space");
  resolveSave!(); await wait();
  assert(!document.querySelector('[aria-label="保存 Gadget 副本"]'), "Successful section copy dismisses dialog");
  results.push("actual task/workspace/global section menus expose unique in-app copy entries, no export/move, and dispatch copyScope");
  return (window as any).require("electron").ipcRenderer.send("fixture-result", { status: "passed", tests: results });
}
void main().catch(error => (window as any).require("electron").ipcRenderer.send("fixture-result", { status: "failed", error: String(error.stack || error) }));
