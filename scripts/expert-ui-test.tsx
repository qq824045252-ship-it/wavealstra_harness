import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { HubAuthoringModal } from "../src/renderer/src/components/hub/HubAuthoringModal";
import { ExpertBindingModal } from "../src/renderer/src/components/hub/ExpertBindingModal";
import { useAppStore } from "../src/renderer/src/store/appStore";
import "../src/renderer/src/styles/global.css";

let root: Root | undefined;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
async function until(predicate: () => unknown, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await settle(); }
}
function mount(node: React.ReactNode): void {
  if (root) flushSync(() => root!.unmount());
  document.body.innerHTML = "";
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root!.render(node));
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}; ${document.querySelector('[role=alert]')?.textContent ?? "no error"}`);
  return found;
}
function click(text: string): void { flushSync(() => button(text).click()); }
function fill(selector: string, value: string): void {
  const control = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!;
  const proto = control instanceof HTMLInputElement ? HTMLInputElement.prototype : control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  flushSync(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true })); });
}
const expert = { id: "fixture-expert", name: "研发助理", description: "推进研发", enabled: true, installed: true, skills: [], emoji: "🧙", instructions: "保留项目决策", revision: "template-1", mcpIds: [], connectorIds: [] };
const skills = Array.from({ length: 12 }, (_, i) => ({ id: `skill-${i}`, name: `验收技能 ${i}`, description: "fixture", enabled: true, installed: true }));
let api: any;
function setup(): void {
  api = {
    agent: {
      getExpertDetail: async () => ({ ...expert }), updateExpert: async (input: any) => ({ ...expert, ...input, revision: "template-2" }),
      authorExpert: async (input: any) => ({ expert: { ...expert, ...input } }), cancelExpertAuthoring: async () => {},
      listExperts: async () => [expert], listMarketExperts: async () => [],
    },
    mcp: { listServers: async () => [{ name: "fixture-mcp", installed: true, disabled: false }] },
  };
  (window as any).api = api;
  useAppStore.setState({ experts: [expert] as any, skills: skills as any, connectors: [{ id: "fixture-connector", name: "测试连接器" }] as any, refreshExperts: async () => {}, refreshSkills: async () => {}, refreshConnectors: async () => {} });
}

export async function run(): Promise<string[]> {
  const results: string[] = [];
  setup(); let closed = 0; let created: any = null;
  api.agent.authorExpert = async (input: any) => { created = input; return { expert: { ...expert, ...input } }; };
  mount(<HubAuthoringModal mode="expert" skills={skills as any} onClose={() => closed++} onCreated={() => {}} />);
  check(button("创建").disabled, "empty expert must not submit");
  fill(".expert-editor-field input", "长期研发助理");
  fill(".expert-editor-field textarea", "推进项目");
  fill(".expert-editor-field textarea[rows='8']", "长期维护决策，给出可验证的下一步。");
  (document.querySelector(".expert-editor-overlay") as HTMLElement).click();
  check(closed === 0 && (document.querySelector(".expert-editor-field input") as HTMLInputElement).value === "长期研发助理", "backdrop must preserve entered draft");
  await until(() => document.body.textContent?.includes("fixture-mcp"), "capabilities loaded");
  const boxes = document.querySelectorAll<HTMLInputElement>(".expert-capabilities input[type=checkbox]");
  flushSync(() => { boxes[0].click(); boxes[12].click(); boxes[13].click(); });
  click("创建"); await until(() => closed === 1, "manual creation completed");
  check(created.name === "长期研发助理" && created.skillIds.includes("skill-0") && created.mcpIds.includes("fixture-mcp") && created.connectorIds.includes("fixture-connector"), "create must save name/prompt and capability configuration");
  results.push("manual creation, required fields, capability selection, backdrop draft protection");

  setup(); let update: any;
  api.agent.updateExpert = async (input: any) => { update = input; return { ...expert, ...input }; };
  mount(<HubAuthoringModal mode="expert" expertId={expert.id} skills={skills as any} onClose={() => {}} onCreated={() => {}} />);
  await until(() => document.querySelector(".expert-editor-field input"), "template loaded");
  fill(".expert-editor-field textarea[rows='8']", "模板新职责"); click("保存专家模板");
  await until(() => update, "template save");
  check(update.expectedRevision === "template-1" && update.instructions === "模板新职责", "template save must include optimistic revision and edited instructions");
  results.push("template editing preserves scope and revision guard");

  setup(); let createCount = 0; let bindCount = 0;
  api.agent.authorExpert = async (input: any) => { createCount++; return { expert: { ...expert, ...input } }; };
  mount(<HubAuthoringModal mode="expert" skills={skills as any} onClose={() => {}} onCreated={() => {}} onExpertSaved={async () => { bindCount++; if (bindCount === 1) throw new Error("fixture binding temporarily failed"); }} />);
  fill(".expert-editor-field input", "可重试专家"); fill(".expert-editor-field textarea", "研发定位"); fill(".expert-editor-field textarea[rows='8']", "维护长期工作");
  click("创建"); await until(() => document.body.textContent?.includes("重试后续操作"), "post-create failure retry");
  click("重试后续操作"); await until(() => bindCount === 2, "binding retried");
  check(createCount === 1, "retry after binding failure must not author a duplicate expert");
  results.push("partial creation success retries binding without duplicate template creation");

  setup(); let lateResolve!: (value: any) => void; let cancellation: string | undefined;
  api.agent.generateExpertAuthoringDraft = async () => new Promise((resolve) => { lateResolve = resolve; });
  api.agent.cancelExpertAuthoring = async (id: string) => { cancellation = id; };
  mount(<HubAuthoringModal mode="expert" skills={skills as any} onClose={() => {}} onCreated={() => {}} />);
  fill(".expert-editor-inline textarea", "生成项目助理"); click("AI 生成草稿");
  check(button("创建").disabled, "cannot save while AI draft is running");
  // 草稿请求前还有一次异步辅助操作（crypto.subtle 摘要 + localStorage 幂等键），
  // 所以 mock 的 Promise 要等一轮微任务才存在；先等请求真正发出，再测取消。
  await until(() => Boolean(lateResolve), "draft request starts");
  click("取消生成"); fill(".expert-editor-field input", "用户手写名字");
  lateResolve({ name: "迟到草稿", description: "迟到", instructions: "迟到", skillIds: [] }); await settle();
  check(Boolean(cancellation) && (document.querySelector(".expert-editor-field input") as HTMLInputElement).value === "用户手写名字", "cancel must reach API and ignore late result");
  results.push("AI cancellation prevents late result from overwriting manual edits");

  setup(); let binding: any = { taskId: "source-task", desired: { revision: "task-1", sourceExpertId: "removed-template", name: "卸载后仍保留的身份", instructions: "任务专属职责", skillIds: [], mcpIds: [], connectorIds: [] }, active: null, pending: false };
  const saves: any[] = [];
  useAppStore.setState({ refreshTaskExpertBinding: async () => binding, saveTaskExpertBinding: async (input: any) => { saves.push(input); binding = { ...binding, desired: input.expertId === null ? null : input.custom ? { ...binding.desired, ...input.custom, revision: "task-2" } : { ...expert, sourceExpertId: input.expertId, revision: "task-3" }, pending: true }; return binding; } });
  mount(<ExpertBindingModal taskId="source-task" onClose={() => {}} />);
  await until(() => document.body.textContent?.includes("原专家模板已卸载"), "missing source preserved");
  fill(".expert-editor-field input", "这个 Bot 的专属名字"); click("仅保存到当前任务");
  await until(() => saves.length === 1, "task local save");
  await until(() => document.body.textContent?.includes("待生效"), "pending status rendered");
  check(saves[0].taskId === "source-task" && saves[0].expectedRevision === "task-1" && saves[0].custom.name === "这个 Bot 的专属名字", "save must stay on target task and carry revision");
  check(document.body.textContent?.includes("待生效"), "pending application must be visible");
  click("解除绑定"); await until(() => saves.length === 2, "orphan unbind");
  await settle();
  check(saves[1].expertId === null && saves[1].taskId === "source-task", "removed template can still be unbound");
  results.push("task-local edit, delayed application, missing template name and unbind");

  click("创建专家并绑定");
  await settle();
  const dialogs = document.querySelectorAll<HTMLElement>("[role=dialog]");
  const createDialog = dialogs[dialogs.length - 1];
  const fields = createDialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".expert-editor-field input,.expert-editor-field textarea");
  for (const [i, value] of ["从任务创建", "研发职责", "持续维护项目"].entries()) {
    const control = fields[i]; const proto = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    flushSync(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  click("创建"); await until(() => saves.length === 3, "create bound to original task");
  check(saves[2].taskId === "source-task" && saves[2].expertId === expert.id, "create from task must bind original task");
  results.push("creating an expert from task binds back without summoning new task");
  return results;
}

export async function preview(): Promise<void> {
  setup(); mount(<HubAuthoringModal mode="expert" skills={skills as any} onClose={() => {}} onCreated={() => {}} />); await settle();
  const modal = document.querySelector<HTMLElement>(".expert-editor-modal")!;
  check(modal.getBoundingClientRect().top >= 0 && modal.getBoundingClientRect().bottom <= innerHeight, "modal must fit viewport");
  modal.scrollTop = modal.scrollHeight; await settle();
  const rect = button("创建").getBoundingClientRect(); check(rect.top >= 0 && rect.bottom <= innerHeight, "save action must stay reachable in small window");
}
export function dispose(): void { if (root) flushSync(() => root!.unmount()); root = undefined; }
