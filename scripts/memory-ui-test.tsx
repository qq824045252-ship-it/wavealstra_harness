import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import "../src/renderer/src/styles/global.css";
import MemoryTab from "../src/renderer/src/components/settings/MemoryTab";
import MemoryL0Explorer from "../src/renderer/src/components/settings/MemoryL0Explorer";
import { useAppStore } from "../src/renderer/src/store/appStore";
import "../src/renderer/src/components/settings/Memory.css";

let root: Root | undefined;
let host: HTMLDivElement;
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
async function until(predicate: () => unknown, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await settle(); }
}
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(node: React.ReactNode): void {
  if (root) flushSync(() => root!.unmount());
  document.body.innerHTML = "";
  document.body.style.cssText = "overflow:auto;background:var(--surface-main);padding:24px;display:block";
  host = document.createElement("div");
  host.className = "memory-tab";
  host.style.maxWidth = "1120px";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
async function click(text: string | RegExp): Promise<void> {
  const button = buttons().find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")) && b.getClientRects().length);
  check(button, `Missing visible button: ${text}`);
  check(!button!.disabled, `Button disabled: ${text}`);
  flushSync(() => button!.click());
  await settle();
}
async function toggleCheck(selector: string, index = 0): Promise<void> {
  const input = host.querySelectorAll<HTMLInputElement>(selector)[index];
  check(input && !input.disabled, `Missing or disabled checkbox: ${selector} ${index}`);
  flushSync(() => input.click()); await settle();
}
async function filter(label: string, value: string): Promise<void> {
  const control = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(new Event(control instanceof HTMLInputElement ? "input" : "change", { bubbles: true }));
  });
  await settle();
}
const raw = (id: string, extra = {}) => ({
  id, taskId: `task-${id}`, taskTitle: `电容计算与模型验证 ${id}`, userText: `对话 ${id}：以后计算电容时，先核对串并联结构及单位，再给出结果。`,
  assistantText: `助手原文 ${id}`, contentHash: id, capturedAt: 1790040000000, extractionState: "completed", attemptCount: 1, metadata: {}, ...extra,
});
const atom = { id: "memory-a", kind: "procedure", title: "电容计算采用公共知识库串并联模型原理", content: "先核对模型和单位，再计算并验证结果。", status: "active", importance: 1, confidence: .98, explicit: true, sourceType: "user", tags: [], scopes: [{ scopeType: "workspace", scopeId: "ws", binding: "primary" }], evidence: [], relations: [], createdAt: 1790040000000, updatedAt: 1790040000000 };
const candidate = (id: string, status: string) => ({ id, status, slug: id, title: status === "stale" ? "历史流程" : atom.title, description: atom.content, instructions: "# 电容计算\n1. 核对单位\n2. 核对连接结构\n3. 计算并验证", sourceMemoryIds: [atom.id], scopeType: "workspace", scopeId: "ws", distinctTaskCount: 1, completedTaskCount: 1, evidenceCount: 3, updatedAt: 1790040000000, installedSkillId: status === "materialized" ? "learned-capacitor" : undefined });
const stats = { total: 1, active: 1, l0Turns: 2, pendingTurns: 0, failedTurns: 0, activeScenarios: 0, activeCoreProfiles: 0, byScope: { global: 0, workspace: 1, project: 0, task: 0 }, byKind: { procedure: 1 }, byStatus: { active: 1 }, candidates: {}, skillCandidates: 0, skillRevisionCandidates: 0, skillInvocations: 0 };
let turns = [raw("A"), raw("B", { taskTrashed: true })];
let changed = new Set<() => void>();
let api: any;
function fixtures(): void {
  turns = [raw("A"), raw("B", { taskTrashed: true })];
  changed = new Set();
  api = {
    agent: { getAppSettings: async () => ({ memoryEnabled: true }), updateAppSettings: async () => ({ memoryEnabled: false }) },
    db: { onMemoryChanged: (fn: () => void) => { changed.add(fn); return () => changed.delete(fn); } },
    memory: {
      list: async () => [atom], get: async (id: string) => id === atom.id ? atom : undefined, history: async () => [],
      stats: async () => ({ ...stats, l0Turns: turns.length }), candidates: async () => [], scenarios: async () => [], coreProfiles: async () => [], dismissedProjections: async () => [], projectionProposals: async () => [],
      turns: async (request: any = {}) => turns.filter((t) => (!request.taskId || t.taskId === request.taskId) && (!request.extractionState || t.extractionState === request.extractionState) && (!request.query || `${t.userText} ${t.assistantText}`.includes(request.query))).slice(0, request.limit ?? 500), turnTasks: async () => turns.map((t) => ({ id: t.taskId, title: t.taskTitle, trashed: Boolean(t.taskTrashed) })),
      getTurn: async (id: string) => turns.find((t) => t.id === id), memoriesForTurn: async () => [atom],
      skillCandidates: async () => [candidate("generated", "materialized"), candidate("history", "stale")],
      skillEffectiveness: async () => [], skillEffectivenessSummary: async () => [], skillRevisionCandidates: async () => [],
      extractPendingTurns: async () => ({ processedTurns: 0, failedTurns: 0, skippedTasks: 0, interrupted: false }),
    },
    memoryGateway: { status: async () => ({ enabled: false, running: false, writeEnabled: false, port: 3351 }), listGrants: async () => [] },
  };
  (window as any).api = api;
  useAppStore.setState({ spaces: [{ id: "ws", name: "研发工作空间" } as any], projects: [], tasks: [] });
}

function skillHistoryFixtures() {
  fixtures();
  const revision = (id: string, status: string) => ({ id, skillId: "learned-capacitor", title: `电容计算修订 ${id}`, status, baseVersion: "1.0.0", needsRevisionCount: 1, incorrectCount: 0, failedInvocationCount: 0, issueSummary: "统一输入单位后再计算。", proposedInstructions: "先确认单位。", baseInstructions: "原计算流程。" });
  const data = {
    candidates: [candidate("ready", "ready"), candidate("generated", "materialized"),
      { ...candidate("stale-a", "stale"), title: "电容计算历史" },
      { ...candidate("rejected-b", "rejected"), title: "月度 KPI 表结构历史" },
      { ...candidate("stale-c", "stale"), title: "项目流程历史" }],
    revisions: [revision("ready-revision", "ready"), revision("generated-revision", "materialized"), revision("stale-revision", "stale"), revision("rejected-revision", "rejected")],
  };
  api.memory.skillCandidates = async () => structuredClone(data.candidates);
  api.memory.skillRevisionCandidates = async () => structuredClone(data.revisions);
  const requests: any[] = [];
  const remove = (request: any) => {
    const key = request.kind === "candidate" ? "candidates" : "revisions";
    const before = data[key].length;
    (data as any)[key] = data[key].filter((item) => !(item.status === "stale" || item.status === "rejected") || !(request.all || request.ids.includes(item.id)));
    return before - data[key].length;
  };
  api.memory.deleteSkillHistory = async (request: any) => { requests.push(request); return remove(request); };
  return { data, requests, remove };
}

function learningFixtures() {
  fixtures();
  const titles = ["Git Bash 下执行 Windows 原生命令时保留参数", "串并联电容计算与单位核对", "在 PowerPoint 导出前检查字体和页面比例", "KiCad 原理图连接与电气规则检查", "从任务记录整理可复用的验证步骤"];
  const items = Array.from({ length: 45 }, (_, index) => ({ ...candidate(`pending-${index}`, index % 2 ? "draft" : "ready"), title: `${titles[index % titles.length]} · ${index + 1}`, scopeType: index % 3 ? "global" : "workspace", distinctTaskCount: index + 1, evidenceCount: index + 3, instructions: `${candidate("", "ready").instructions}\n\n适用条件：在工具任务执行前，先确认环境和输入。\n\n执行步骤：\n1. 确认工作目录和命令参数。\n2. 使用原生 PowerShell 执行 Windows 命令。\n3. 读取实际输出，核对返回值。\n\n验证：保留执行结果和可复核的检查记录。` }));
  const requests: { id: string; action: string }[] = [];
  api.memory.skillCandidates = async () => structuredClone(items);
  api.memory.skillLearningStatus = async () => ({ procedures: 225, reusableProcedures: 220, pendingTurns: 3, failedTurns: 4, retryableFailedTurns: 3, latestError: 'Resource exhausted. Please try again later. '.repeat(30), blockedSkills: [{ id: "blocked", title: "历史流程来源变更", reason: "来源记忆或审批记录已不存在，请重新学习并审核。" }] });
  api.memory.approveSkillCandidate = async (id: string) => { requests.push({ id, action: "approve" }); const item = items.find((item) => item.id === id)!; item.status = "materialized"; return item; };
  api.memory.rejectSkillCandidate = async (id: string) => { requests.push({ id, action: "reject" }); const item = items.find((item) => item.id === id)!; item.status = "rejected"; return item; };
  return { items, requests };
}

function projectionFixtures() {
  fixtures();
  const data = {
    scenes: [
      { id: "scene-active", title: "有效工作场景", summary: "已批准的工作场景摘要", status: "active", scopeType: "global", sourceMemoryIds: [atom.id], updatedAt: 1 },
      { id: "scene-stale", title: "过期工作场景", summary: "来源变化后的历史摘要", status: "stale", scopeType: "global", sourceMemoryIds: [atom.id], updatedAt: 1 },
    ],
    profiles: [{ id: "profile-active", title: "有效工作画像", content: "已批准的画像", status: "active", scopeType: "global", sourceScenarioIds: ["scene-active"], updatedAt: 1 }],
    dismissed: [
      { id: "scene-blocked", kind: "scenario", title: "已屏蔽的工作场景", scopeType: "global", dismissedAt: 1 },
      { id: "profile-blocked", kind: "profile", title: "已屏蔽的工作画像", scopeType: "global", dismissedAt: 1 },
    ],
    proposals: [
      { id: "scene-pending", kind: "scenario", title: "待批准的工作场景", body: "待批准的摘要", status: "pending", scopeType: "global", sourceIds: [atom.id], targetId: "target-pending", updatedAt: 1 },
      { id: "scene-rejected", kind: "scenario", title: "已拒绝的工作场景", body: "已拒绝的摘要", status: "rejected", scopeType: "global", sourceIds: [atom.id], targetId: "target-rejected", updatedAt: 1 },
      { id: "profile-pending", kind: "profile", title: "待批准的工作画像", body: "画像提案", status: "pending", scopeType: "global", sourceIds: ["scene-active"], targetId: "target-profile", updatedAt: 1 },
    ],
  };
  api.memory.scenarios = async () => data.scenes;
  api.memory.coreProfiles = async () => data.profiles;
  api.memory.dismissedProjections = async () => data.dismissed;
  api.memory.projectionProposals = async () => data.proposals;
  api.memory.stats = async () => ({ ...stats, scenarios: data.scenes.filter((item) => item.status === "active").length, coreProfiles: data.profiles.filter((item) => item.status === "active").length });
  const requests: any[] = [];
  const remove = (request: any) => {
    const matching = (item: { id: string }) => request.all || request.targetIds?.includes(item.id);
    const previous = request.kind === "scenario" ? data.scenes.length : data.profiles.length;
    if (request.kind === "scenario") data.scenes = data.scenes.filter((item) => !matching(item));
    else data.profiles = data.profiles.filter((item) => !matching(item));
    const previousDismissed = data.dismissed.length, previousProposals = data.proposals.length;
    data.dismissed = data.dismissed.filter((item) => item.kind !== request.kind || !matching(item));
    data.proposals = data.proposals.filter((item) => item.kind !== request.kind || !(request.all || request.proposalIds?.includes(item.id) || request.targetIds?.includes(item.targetId)));
    return { projections: previous - (request.kind === "scenario" ? data.scenes.length : data.profiles.length), dismissals: previousDismissed - data.dismissed.length, proposals: previousProposals - data.proposals.length, invalidatedProfiles: 0, dependentProposals: 0 };
  };
  api.memory.deleteProjectionRecords = async (request: any) => { requests.push(request); return remove(request); };
  return { data, requests, remove };
}

function organizationFixtures() {
  fixtures();
  const data: { run: any; starts: Array<string | undefined>; applied: number; undone: number } = { run: null, starts: [], applied: 0, undone: 0 };
  const ready = () => ({ id: "organization-fixture", status: "ready", createdAt: Date.now(), updatedAt: Date.now(), total: 124, scanned: 124, skipped: 0, unchanged: 119,
    completedBatches: 8, totalBatches: 8, beforeChars: 12600, afterChars: 8400, proposals: [
      { id: "merge", action: "merge", reason: "三次对话都确认先完善示波器，再开发频谱仪，保留一个有效版本并汇集来源。", scopes: atom.scopes,
        before: [{ ...atom, id: "first", kind: "decision", title: "优先完善示波器", content: "当前应优先完成示波器功能，再开始开发频谱仪。" }, { ...atom, id: "second", kind: "decision", title: "频谱仪开发顺序", content: "用户再次确认，先完善示波器，再开发频谱仪。" }],
        after: [{ kind: "decision", title: "仪器开发顺序", content: "先完善示波器，再开发频谱仪。" }] },
      { id: "rewrite", action: "rewrite", reason: "精简重复叙述，保留串并联模型与单位检查要求。", scopes: atom.scopes, before: [{ ...atom, content: "用户指出，未来在计算电容时，需要先仔细核对模型的串并联结构以及所有输入的单位，再根据确认的模型计算，并检查计算结果是否正确。" }], after: [{ kind: "procedure", title: atom.title, content: atom.content }] },
      { id: "conflict", action: "conflict", reason: "两次记录的预算不同，现有来源未说明是否调整，保持原样等待确认。", scopes: [{ scopeType: "project", scopeId: "project-budget", binding: "owned" }], before: [{ id: "budget-a", kind: "constraint", title: "设备采购预算", content: "采购预算上限八万元。" }, { id: "budget-b", kind: "constraint", title: "项目预算", content: "采购预算上限十万元。" }], after: [] },
    ] });
  api.memory.organization = async () => data.run ? structuredClone(data.run) : null;
  api.memory.startOrganization = async (resumeId?: string) => { data.starts.push(resumeId); data.run = { ...ready(), status: "scanning", scanned: 0, completedBatches: 0, proposals: [] }; return structuredClone(data.run); };
  api.memory.pauseOrganization = async () => { data.run.status = "paused"; return structuredClone(data.run); };
  api.memory.applyOrganization = async () => { data.applied++; data.run.status = "applied"; return structuredClone(data.run); };
  api.memory.undoOrganization = async () => { data.undone++; data.run.status = "undone"; return structuredClone(data.run); };
  api.memory.dismissOrganization = async () => { data.run.status = "dismissed"; data.run.proposals = []; return structuredClone(data.run); };
  return { data, ready };
}

export async function run(): Promise<string[]> {
  const results: string[] = [];
  fixtures();
  const a = deferred(), b = deferred();
  const requested: string[] = [];
  api.memory.getTurn = (id: string) => { requested.push(id); return id === "A" ? a.promise : b.promise; };
  mount(<MemoryL0Explorer onDeleteTurns={async () => false} onOpenMemory={() => {}} />);
  await until(() => host.querySelectorAll(".memory-turn-row").length === 2, "L0 list");
  await click(/^对话 A/); await until(() => requested.includes("A"), "A request");
  await click(/^对话 B/); await until(() => requested.includes("B"), "B request");
  b.resolve(raw("B"));
  await until(() => host.querySelector(".memory-turn-detail")?.textContent?.includes("助手原文 B"), "B detail");
  a.resolve(raw("A")); await settle();
  check(!host.querySelector(".memory-turn-detail")?.textContent?.includes("助手原文 A"), "late A response must not replace B detail");
  results.push("L0 A/B out-of-order responses keep selected detail and evidence consistent");

  fixtures(); mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "initial load");
  await click(/^对话来源/); await until(() => host.querySelectorAll(".memory-turn-row").length === 2, "L0 mounted");
  await click(/^对话 A/);
  await until(() => host.querySelector(".memory-turn-detail")?.textContent?.includes("助手原文 A"), "selected A");
  turns = [raw("A", { assistantText: "刷新后的助手原文" }), raw("B")];
  await click("刷新");
  await until(() => host.querySelector(".memory-turn-detail")?.textContent?.includes("刷新后的助手原文"), "parent refresh reaches selected detail");
  turns = [raw("A", { assistantText: "提炼完成通知后的原文" }), raw("B")];
  changed.forEach((fn) => fn());
  await until(() => host.querySelector(".memory-turn-detail")?.textContent?.includes("提炼完成通知后的原文"), "notification reaches L0");
  results.push("parent refresh and extraction notifications refresh both L0 list and selected detail");

  await click("技能学习");
  await until(() => buttons().some((b) => b.textContent === "已生成 1"), "skill groups");
  check(host.textContent?.includes("暂无待处理流程"), "pending zero must not mix stale/materialized candidates into pending list");
  await click("历史记录 1");
  check(host.textContent?.includes("历史快照仅供审核"), "history explains source invalidation");
  await click("已生成 1");
  await click("查看来源记忆");
  await until(() => buttons().some((button) => button.textContent === "编辑" && button.getClientRects().length), "skill source opens and selects L1");
  results.push("skill groups/counts and skill-to-L1 evidence navigation");

  await click("设置");
  const saving = deferred();
  let writes = 0;
  api.agent.updateAppSettings = () => { writes++; return saving.promise; };
  await until(() => !host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="使用记忆"]')?.disabled, "settings loaded");
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="使用记忆"]')!;
  flushSync(() => toggle.click()); await settle();
  check(toggle.disabled, "pending setting write disables switch"); toggle.click();
  check(writes === 1, "busy switch prevents duplicate writes");
  await click("技能学习"); await click("设置");
  const returningToggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="使用记忆"]')!;
  check(returningToggle.disabled && returningToggle.getAttribute("aria-checked") === "false", "tab navigation must not replace an in-flight setting with the old persisted value");
  saving.reject(new Error("测试保存失败"));
  await until(() => !returningToggle.disabled, "failed save finishes");
  check(returningToggle.getAttribute("aria-checked") === "true", "failed save restores previous value");
  check(host.querySelector('[role="status"]')?.textContent?.includes("测试保存失败"), "save failure is visible near control");
  results.push("named accessible switch locks during save, reports failure, and rolls back");

  await click("技能学习");
  await until(() => buttons().some((b) => b.textContent === "已生成 1"), "skills return");
  await click("前往技能中心");
  check(useAppStore.getState().page === "skills" && !useAppStore.getState().settingsOpen, "skill-center action navigates and closes settings");
  results.push("skill-center shortcut navigates to the real store page");

  fixtures();
  let learningRetries = 0;
  api.memory.skillLearningStatus = async () => ({ procedures: 0, reusableProcedures: 0, failedTurns: 17, retryableFailedTurns: 17, pendingTurns: 17,
    latestError: "Unsupported parameter: temperature", blockedSkills: [{ id: "old-skill", title: "旧流程", reason: "来源记忆或审批记录已不存在，请重新学习并审核" }] });
  api.memory.retryFailedTurns = async () => { learningRetries++; return 17; };
  mount(<MemoryTab />);
  await click("技能学习");
  await until(() => host.textContent?.includes("17 条对话提炼失败"), "learning failure diagnostics");
  check(host.textContent?.includes("尚无可复用流程") && host.textContent.includes("来源记忆或审批记录已不存在"), "empty pipeline and orphaned skill explain their causes");
  flushSync(() => host.querySelector<HTMLElement>('.skill-learning-diagnostics summary')!.click());
  await click("重试失败提炼");
  check(learningRetries === 1 && host.textContent?.includes("已安排重试 17 条"), "retry uses real recovery API and reports queued processing");
  api.memory.retryFailedTurns = async () => { throw new Error("当前模型尚未就绪"); };
  await click("重试失败提炼");
  check(host.textContent?.includes("当前模型尚未就绪"), "retry failures stay visible");
  api.memory.skillLearningStatus = async () => ({ procedures: 0, reusableProcedures: 0, failedTurns: 17, retryableFailedTurns: 0, pendingTurns: 0, blockedSkills: [] });
  changed.forEach((fn) => fn());
  await until(() => host.textContent?.includes("其中 0 条可重试"), "archived failure explanation");
  check(buttons().find((button) => button.textContent === "重试失败提炼")?.disabled, "archived sources cannot be retried");
  results.push("skill learning explains empty source, failed extraction and orphaned skills, and supports retry with visible errors");

  fixtures();
  api.memory.scenarios = async () => [{ id: "scenario-old", title: "旧版计算场景", summary: "来源变更后的审计记录", status: "stale", scopeType: "workspace", scopeId: "ws", sourceMemoryIds: [atom.id], updatedAt: 1 }];
  api.memory.coreProfiles = async () => [{ id: "profile-old", title: "旧版计算画像", content: "仅供审计", status: "stale", scopeType: "workspace", scopeId: "ws", sourceScenarioIds: ["scenario-old"], updatedAt: 1 }];
  mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "projection fixture");
  await click(/^有效画像/);
  check(!buttons().some((button) => button.textContent === "旧版计算场景" && button.getClientRects().length), "stale projections stay out of active view");
  await click(/^查看过期历史/);
  await click("旧版计算场景");
  await until(() => host.querySelector(".memory-projection-focus") === document.activeElement, "L3 source focuses exact L2 scenario");
  check(document.activeElement?.textContent?.includes("旧版计算场景"), "L3 source opens the right historical scenario");
  results.push("L3 source opens, reveals, and focuses the exact historical L2 scenario");

  fixtures();
  api.memory.list = async () => [];
  mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "source missing from current list");
  await click("技能学习");
  await until(() => buttons().some((b) => b.textContent === "已生成 1"), "source skill");
  await click("已生成 1"); await click("查看来源记忆");
  await until(() => buttons().some((b) => b.textContent === "编辑" && b.getClientRects().length), "source beyond list limit");
  await click("刷新");
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "source refreshed");
  check(buttons().some((b) => b.textContent === "编辑" && b.getClientRects().length), "refresh retains a directly opened source outside the list window");
  results.push("direct source lookup survives list limits and refresh");

  fixtures();
  let deletes = 0;
  const deletion = deferred<number>();
  api.memory.deleteAllTurns = () => { deletes++; return deletion.promise; };
  mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "delete fixture loaded");
  await click(/^对话来源/);
  await until(() => host.querySelectorAll(".memory-turn-row").length === 2, "delete sources loaded");
  await click(/^对话 A/);
  await click("删除全部对话来源");
  const dialog = () => document.querySelector('[role="dialog"]');
  check(dialog()?.textContent?.includes("不受当前筛选或显示条数限制"), "confirmation makes global delete scope explicit");
  check(dialog()?.textContent?.includes("证据摘录"), "confirmation explains retained evidence");
  const dialogClick = async (label: string): Promise<void> => {
    const button = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
    flushSync(() => button.click()); await settle();
  };
  await dialogClick("取消");
  check(deletes === 0 && !dialog(), "cancel leaves all sources intact");
  api.memory.deleteAllTurns = async () => { throw new Error("删除测试失败"); };
  await click("删除全部对话来源"); await dialogClick("确认删除全部来源");
  await until(() => host.querySelector('[role="status"]')?.textContent?.includes("删除测试失败"), "delete error visible");
  check(host.querySelectorAll(".memory-turn-row").length === 2, "failed delete retains displayed sources");
  api.memory.deleteAllTurns = () => { deletes++; return deletion.promise; };
  await click("删除全部对话来源"); await dialogClick("确认删除全部来源");
  check(!dialog() && deletes === 1, "confirmation issues exactly one deletion");
  check(buttons().find((b) => b.textContent === "删除全部对话来源")?.disabled, "in-flight deletion locks the action");
  turns = []; deletion.resolve(2);
  await until(() => host.querySelectorAll(".memory-turn-row").length === 0 && host.textContent?.includes("对话来源 · 0"), "delete clears source list and count");
  check(!host.querySelector(".memory-turn-detail")?.textContent?.includes("助手原文 A"), "delete clears selected original text");
  check(host.querySelector<HTMLSelectElement>('[aria-label="筛选来源任务"]')?.options.length === 1, "deleted source tasks leave the filter");
  check(host.textContent?.includes("记忆条目 · 1"), "durable memory count is preserved");
  results.push("bulk source delete confirms scope, handles cancel/failure, locks duplicates, and refreshes count/list/detail/filters");

  fixtures();
  turns = [raw("A"), raw("B", { extractionState: "failed" }), raw("C", { extractionState: "pending" })];
  mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "selection fixture");
  await click(/^对话来源/);
  await until(() => host.querySelectorAll(".memory-turn-row").length === 3, "selection list");
  const rowChecks = ".memory-turn-select input";
  const allCheck = ".memory-select-all input";
  const selectedCount = () => host.querySelectorAll(`${rowChecks}:checked`).length;
  await toggleCheck(rowChecks); await toggleCheck(rowChecks, 1);
  check(selectedCount() === 2 && host.querySelector<HTMLInputElement>(allCheck)?.indeterminate, "partial multi-selection sets indeterminate select-all");
  check(!host.querySelector(".memory-turn-row.active"), "checkbox selection does not open unrelated detail");
  await toggleCheck(allCheck);
  check(selectedCount() === 3, "select-all covers the current list");
  await toggleCheck(allCheck);
  check(selectedCount() === 0, "select-all can clear the list");
  await toggleCheck(rowChecks);
  await filter("搜索对话原文", "对话 B");
  await until(() => host.querySelectorAll(".memory-turn-row").length === 1, "search filtered");
  check(selectedCount() === 0, "search change clears hidden selections");
  await toggleCheck(allCheck);
  check(selectedCount() === 1 && host.querySelector(".memory-turn-row")?.textContent?.includes("对话 B"), "filtered select-all does not include hidden records");
  await filter("搜索对话原文", "");
  await until(() => host.querySelectorAll(".memory-turn-row").length === 3, "search cleared");
  await filter("筛选来源任务", "task-A");
  await until(() => host.querySelectorAll(".memory-turn-row").length === 1, "task filtered");
  check(selectedCount() === 0, "task change clears selections");
  await toggleCheck(allCheck);
  await filter("筛选提炼状态", "failed");
  await until(() => host.querySelectorAll(".memory-turn-row").length === 0, "state filtered empty");
  check(host.textContent?.includes("已选 0 条"), "state change clears selections");
  await filter("筛选来源任务", ""); await filter("筛选提炼状态", "");
  await until(() => host.querySelectorAll(".memory-turn-row").length === 3, "filters reset");
  await toggleCheck(rowChecks); await toggleCheck(rowChecks, 2);
  await click(/^对话 B/);
  check(selectedCount() === 2, "opening detail does not change deletion selection");
  await click(/^对话 A/);
  await until(() => host.querySelector(".memory-turn-detail")?.textContent?.includes("助手原文 A"), "selected deletion detail");
  const selectedDeletion = deferred<number>();
  const deleteRequests: string[][] = [];
  api.memory.deleteTurns = (ids: string[]) => { deleteRequests.push(ids); return selectedDeletion.promise; };
  await click("删除选中（2）");
  check(dialog()?.textContent?.includes("删除选中的 2 条") && dialog()?.textContent?.includes("未勾选的来源"), "selection confirmation states exact count and retained data");
  await dialogClick("取消");
  check(deleteRequests.length === 0 && selectedCount() === 2, "cancel preserves selection and sources");
  api.memory.deleteTurns = async () => { throw new Error("多选删除测试失败"); };
  await click("删除选中（2）"); await dialogClick("确认删除选中来源");
  await until(() => host.querySelector('[role="status"]')?.textContent?.includes("多选删除测试失败"), "selected delete failure visible");
  check(selectedCount() === 2 && host.querySelectorAll(".memory-turn-row").length === 3, "failure preserves selected and unselected rows");
  api.memory.deleteTurns = (ids: string[]) => { deleteRequests.push(ids); return selectedDeletion.promise; };
  await click("删除选中（2）"); await dialogClick("确认删除选中来源");
  check(JSON.stringify(deleteRequests) === '[["A","C"]]', "only selected IDs are sent, once");
  check([...host.querySelectorAll<HTMLInputElement>(rowChecks)].every((input) => input.disabled), "pending delete locks selection");
  check(buttons().find((button) => button.textContent === "删除全部对话来源")?.disabled, "pending selected delete locks competing bulk delete");
  turns = [turns[1]]; selectedDeletion.resolve(2);
  await until(() => host.querySelectorAll(".memory-turn-row").length === 1 && host.textContent?.includes("对话来源 · 1"), "selection delete refreshes count/list");
  check(selectedCount() === 0 && host.querySelector(".memory-turn-row")?.textContent?.includes("对话 B"), "unselected source remains and selection clears");
  check(!host.querySelector(".memory-turn-detail")?.textContent?.includes("助手原文 A"), "deleted detail is cleared");
  check(host.textContent?.includes("记忆条目 · 1"), "selected deletion keeps durable memories");
  await toggleCheck(rowChecks);
  turns = []; changed.forEach((fn) => fn());
  await until(() => host.textContent?.includes("对话来源 · 0") && host.textContent?.includes("已选 0 条"), "refresh prunes disappeared selections");
  check(buttons().find((button) => button.textContent === "删除选中（0）")?.disabled, "empty selection disables delete");

  fixtures(); mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "filtered delete fixture");
  await click(/^对话来源/);
  await until(() => host.querySelectorAll(".memory-turn-row").length === 2, "filtered delete list");
  await filter("筛选来源任务", "task-A");
  await until(() => host.querySelectorAll(".memory-turn-row").length === 1, "selected task");
  await toggleCheck(allCheck);
  api.memory.deleteTurns = async (ids: string[]) => { turns = turns.filter((turn) => !ids.includes(turn.id)); return ids.length; };
  await click("删除选中（1）"); await dialogClick("确认删除选中来源");
  await until(() => host.querySelector<HTMLSelectElement>('[aria-label="筛选来源任务"]')?.value === "" && host.querySelector(".memory-turn-row")?.textContent?.includes("对话 B"), "removed task filter resets to remaining sources");
  results.push("multi-select/select-all, filter safety, exact-ID deletion, cancel/failure, busy locking, detail/count refresh, and removed task filters");

  let projectionFixture = projectionFixtures();
  mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "projection delete fixture");
  await click(/^有效场景/);
  const clickLabel = async (label: string): Promise<void> => {
    const button = buttons().find((item) => item.getAttribute("aria-label") === label && item.getClientRects().length)!;
    check(button && !button.disabled, `Missing active control: ${label}`);
    flushSync(() => button.click()); await settle();
  };
  await clickLabel("删除场景：有效工作场景");
  check(dialog()?.textContent?.includes("相关提案和屏蔽记录"), "projection delete explains related records");
  await dialogClick("取消");
  check(projectionFixture.requests.length === 0, "projection cancel has no side effects");
  api.memory.deleteProjectionRecords = async () => { throw new Error("场景删除测试失败"); };
  await clickLabel("删除场景：有效工作场景"); await dialogClick("确认删除记录");
  await until(() => host.querySelector('[role="status"]')?.textContent?.includes("场景删除测试失败"), "projection delete failure");
  check(host.textContent?.includes("有效场景 · 1"), "failed delete keeps active count");
  const delayedProjectionDelete = deferred<any>();
  api.memory.deleteProjectionRecords = (request: any) => { projectionFixture.requests.push(request); return delayedProjectionDelete.promise; };
  await clickLabel("删除场景：有效工作场景"); await dialogClick("确认删除记录");
  check(buttons().find((item) => item.textContent === "删除全部场景记录")?.disabled, "projection deletion locks competing actions");
  check(JSON.stringify(projectionFixture.requests) === '[{"kind":"scenario","targetIds":["scene-active"]}]', "active scene uses the hard-delete API, not dismissal");
  const deleteResult = projectionFixture.remove(projectionFixture.requests[0]);
  projectionFixture.data.profiles[0].status = "stale";
  delayedProjectionDelete.resolve({ ...deleteResult, invalidatedProfiles: 1 });
  await until(() => host.textContent?.includes("有效场景 · 0") && host.textContent?.includes("有效画像 · 0"), "projection counts refresh");
  check(host.querySelector('[role="status"]')?.textContent?.includes("关联的 1 份画像已失效"), "dependency outcome is visible");
  api.memory.deleteProjectionRecords = async (request: any) => { projectionFixture.requests.push(request); return projectionFixture.remove(request); };
  await click(/^查看过期历史/);
  for (const label of ["删除场景：过期工作场景", "删除屏蔽记录：已屏蔽的工作场景", "删除提案：已拒绝的工作场景", "删除提案：待批准的工作场景"]) {
    await clickLabel(label); await dialogClick("确认删除记录");
    await until(() => !buttons().some((item) => item.getAttribute("aria-label") === label), `${label} removed`);
  }
  check(projectionFixture.requests.some((request) => request.proposalIds?.[0] === "scene-rejected"), "rejected proposals delete by proposal ID");
  check(projectionFixture.data.dismissed.some((item) => item.kind === "profile"), "scenario cleanup preserves profile records");

  projectionFixture = projectionFixtures();
  projectionFixture.data.scenes = projectionFixture.data.scenes.filter((item) => item.status === "stale");
  mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "zero-active fixture");
  await click(/^有效场景/);
  check(host.textContent?.includes("有效场景 · 0"), "reproduce zero active with retained history");
  await click("删除全部场景记录");
  check(dialog()?.textContent?.includes("不受当前显示数量限制") && dialog()?.textContent?.includes("过期历史"), "all-scene confirmation covers hidden history and proposal limits");
  await dialogClick("确认删除全部记录");
  await until(() => !host.textContent?.includes("已屏蔽的工作场景") && host.textContent?.includes("查看过期历史 · 0"), "clear all scenario remnants");
  check(JSON.stringify(projectionFixture.requests[0]) === '{"kind":"scenario","all":true}', "clear all is a server-side scope request");
  await click(/^有效画像/);
  await clickLabel("删除画像：有效工作画像"); await dialogClick("确认删除记录");
  await until(() => host.textContent?.includes("有效画像 · 0"), "profile hard delete");
  await click("删除全部画像记录"); await dialogClick("确认删除全部记录");
  await until(() => !host.textContent?.includes("已屏蔽的工作画像") && !host.textContent?.includes("待批准的工作画像"), "clear all profile remnants");
  check(host.textContent?.includes("记忆条目 · 1") && host.textContent?.includes("对话来源 · 2"), "projection deletion preserves memory and source counts");
  results.push("scene/profile hard deletion covers active, history, dismissed and rejected records, cancel/failure, busy state, dependencies and full cleanup at zero active count");

  projectionFixture = projectionFixtures(); mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "projection multi-select fixture");
  await click(/^有效场景/);
  const projectionAll = ".memory-projection-toolbar .memory-select-all input";
  const projectionChecks = () => [...host.querySelectorAll<HTMLInputElement>(".memory-projection-select input")].filter((item) => item.getClientRects().length);
  const selectProjection = (label: string) => toggleCheck(`.memory-projection-select input[aria-label="选择${label}"]`);
  const projectionSelectionCount = () => projectionChecks().filter((item) => item.checked).length;
  await selectProjection("场景：有效工作场景");
  check(host.querySelector<HTMLInputElement>(projectionAll)?.indeterminate, "partial scenario selection shows mixed state");
  await toggleCheck(projectionAll);
  check(projectionSelectionCount() === 4 && host.querySelector<HTMLInputElement>(projectionAll)?.checked, "select all includes active, dismissed and both proposal states but not hidden history");
  await click("清空选择");
  check(projectionSelectionCount() === 0, "clear projection selection");
  await click(/^查看过期历史/);
  await selectProjection("场景：过期工作场景"); await selectProjection("场景：有效工作场景");
  await click(/^收起历史/);
  check(projectionSelectionCount() === 1 && host.textContent?.includes("已选 1 条"), "hidden history is removed from selection");
  await click(/^查看过期历史/);
  check(!host.querySelector<HTMLInputElement>('[aria-label="选择场景：过期工作场景"]')?.checked, "showing history does not restore hidden selections");
  await click(/^有效画像/);
  check(projectionSelectionCount() === 0, "switching projection kind clears selection");
  await selectProjection("画像：有效工作画像"); await click(/^有效场景/);
  check(projectionSelectionCount() === 0, "profile selections cannot leak into scenarios");
  await selectProjection("场景：有效工作场景"); await selectProjection("提案：已拒绝的工作场景");
  projectionFixture.data.scenes = projectionFixture.data.scenes.filter((item) => item.status !== "active");
  changed.forEach((fn) => fn());
  await until(() => host.textContent?.includes("有效场景 · 0") && host.textContent?.includes("已选 1 条"), "refresh prunes removed selections while retaining surviving choices");

  projectionFixture = projectionFixtures(); mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "mixed projection delete fixture");
  await click(/^有效场景/); await click(/^查看过期历史/);
  for (const label of ["场景：有效工作场景", "场景：过期工作场景", "屏蔽记录：已屏蔽的工作场景", "提案：待批准的工作场景"]) await selectProjection(label);
  await click("删除选中（4）");
  check(dialog()?.textContent?.includes("选中的 4 条场景记录") && dialog()?.textContent?.includes("相关提案和屏蔽记录"), "batch confirmation identifies exact selected count and related cleanup");
  await dialogClick("取消");
  check(projectionSelectionCount() === 4 && projectionFixture.requests.length === 0, "batch cancel keeps choices and sends no deletion");
  api.memory.deleteProjectionRecords = async () => { throw new Error("批量删除测试失败"); };
  await click("删除选中（4）"); await dialogClick("确认删除选中记录");
  await until(() => host.querySelector('[role="status"]')?.textContent?.includes("批量删除测试失败"), "batch error feedback");
  check(projectionSelectionCount() === 4, "batch failure retains all choices for retry");
  const batchProjectionDelete = deferred<any>();
  api.memory.deleteProjectionRecords = (request: any) => { projectionFixture.requests.push(request); return batchProjectionDelete.promise; };
  await click("删除选中（4）"); await dialogClick("确认删除选中记录");
  check(projectionChecks().every((item) => item.disabled) && host.querySelector<HTMLInputElement>(projectionAll)?.disabled, "batch pending locks row and select-all controls");
  check(["清空选择", "删除选中（4）", "删除全部场景记录"].every((label) => buttons().find((item) => item.textContent === label)?.disabled), "batch pending locks competing deletion controls");
  check(JSON.stringify(projectionFixture.requests) === '[{"kind":"scenario","targetIds":["scene-active","scene-stale","scene-blocked"],"proposalIds":["scene-pending"]}]', "one exact mixed-ID request is sent for the selected records");
  batchProjectionDelete.resolve(projectionFixture.remove(projectionFixture.requests[0]));
  await until(() => host.textContent?.includes("有效场景 · 0") && host.textContent?.includes("已选 0 条"), "batch success refreshes counts and clears selection");
  check(projectionChecks().length === 1 && host.textContent?.includes("已拒绝的工作场景"), "unselected rejected proposal survives scenario batch deletion");
  check(projectionFixture.data.profiles.length === 1 && host.textContent?.includes("记忆条目 · 1") && host.textContent?.includes("对话来源 · 2"), "batch request keeps unrelated layers and source records");
  api.memory.deleteProjectionRecords = async (request: any) => { projectionFixture.requests.push(request); return projectionFixture.remove(request); };
  await click(/^有效画像/); await toggleCheck(projectionAll);
  check(projectionSelectionCount() === 3, "profile select-all covers active, dismissed and pending records");
  await click("删除选中（3）"); await dialogClick("确认删除选中记录");
  await until(() => host.textContent?.includes("有效画像 · 0") && projectionChecks().length === 0, "profile batch deletion refreshes all sections");
  check(JSON.stringify(projectionFixture.requests[1]) === '{"kind":"profile","targetIds":["profile-active","profile-blocked"],"proposalIds":["profile-pending"]}', "profile batch uses exact profile IDs");
  check(host.querySelector<HTMLInputElement>(projectionAll)?.disabled && buttons().find((item) => item.textContent === "删除选中（0）")?.disabled, "empty projection list disables selection deletion");
  check(projectionFixture.data.proposals.some((item) => item.id === "scene-rejected"), "profile batch preserves unselected scenario proposals");
  results.push("scene/profile multi-select covers mixed records, select-all/clear, hidden history and tab safety, refresh pruning, cancel/error retention, busy locking and exact atomic requests");

  const skillFixture = skillHistoryFixtures(); mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "skill history fixture");
  await click("技能学习");
  await until(() => buttons().some((b) => b.textContent === "历史记录 3"), "skill groups loaded");
  check(!host.querySelector(".memory-skill-history-toolbar"), "pending skills do not offer destructive history controls");
  await click("已生成 1");
  check(!buttons().some((b) => b.getAttribute("aria-label")?.startsWith("删除技能历史")), "generated skills retain skill-center management instead of history deletion");
  await click("历史记录 3");
  const skillChecks = '[aria-label^="选择技能历史："]';
  const skillAll = '[data-history-kind="candidate"] .memory-select-all input';
  await toggleCheck(skillChecks);
  check(host.querySelector<HTMLInputElement>(skillAll)?.indeterminate, "partial history selection is indicated");
  await toggleCheck(skillAll);
  check(host.querySelectorAll(`${skillChecks}:checked`).length === 3, "select all history");
  await click("清空选择");
  check(host.querySelectorAll(`${skillChecks}:checked`).length === 0, "clear skill history selection");
  await toggleCheck(skillChecks);
  await click("待处理 1"); await click("历史记录 3");
  check(host.querySelectorAll(`${skillChecks}:checked`).length === 0, "leaving history clears hidden choices");
  await toggleCheck(skillChecks, 0); await toggleCheck(skillChecks, 1);
  await click("删除选中（2）");
  check(dialog()?.textContent?.includes("待处理记录、已生成记录、技能文件和来源记忆会保留"), "history confirmation states the limited deletion scope");
  await dialogClick("取消");
  check(skillFixture.requests.length === 0 && host.querySelectorAll(`${skillChecks}:checked`).length === 2, "history cancellation retains selection without deleting");
  api.memory.deleteSkillHistory = async () => { throw new Error("历史删除测试失败"); };
  await click("删除选中（2）"); await dialogClick("确认删除历史");
  await until(() => host.querySelector('[role="status"]')?.textContent?.includes("历史删除测试失败"), "history deletion failure");
  check(host.querySelectorAll(`${skillChecks}:checked`).length === 2, "failed history deletion retains choices");
  const delayedHistoryDelete = deferred<number>();
  api.memory.deleteSkillHistory = (request: any) => { skillFixture.requests.push(request); return delayedHistoryDelete.promise; };
  await click("删除选中（2）"); await dialogClick("确认删除历史");
  check([...host.querySelectorAll<HTMLInputElement>(skillChecks)].every((item) => item.disabled) && buttons().find((b) => b.textContent === "清空技能历史")?.disabled, "pending deletion locks history controls");
  check(JSON.stringify(skillFixture.requests) === '[{"kind":"candidate","ids":["stale-a","rejected-b"]}]', "batch deletes only selected history IDs");
  delayedHistoryDelete.resolve(skillFixture.remove(skillFixture.requests[0]));
  await until(() => buttons().some((b) => b.textContent === "历史记录 1") && host.textContent?.includes("已选 0 条"), "history counts and selection refresh");
  check(host.textContent?.includes("项目流程历史"), "unselected history survives");
  api.memory.deleteSkillHistory = async (request: any) => { skillFixture.requests.push(request); return skillFixture.remove(request); };
  await clickLabel("删除技能历史：项目流程历史"); await dialogClick("确认删除历史");
  await until(() => buttons().some((b) => b.textContent === "历史记录 0"), "single history deletion");
  skillFixture.data.candidates.push({ ...candidate("refreshed-history", "stale"), title: "刷新后的历史" });
  changed.forEach((fn) => fn());
  await until(() => buttons().some((b) => b.textContent === "历史记录 1"), "history arrives on refresh");
  await toggleCheck(skillAll);
  skillFixture.data.candidates = skillFixture.data.candidates.filter((item) => item.id !== "refreshed-history");
  changed.forEach((fn) => fn());
  await until(() => buttons().some((b) => b.textContent === "历史记录 0") && host.textContent?.includes("已选 0 条"), "refresh removes disappeared selections");
  await click("清空技能历史");
  check(dialog()?.textContent?.includes("超出列表显示数量"), "full history cleanup covers hidden rows");
  await dialogClick("确认清空历史");
  check(JSON.stringify(skillFixture.requests.at(-1)) === '{"kind":"candidate","all":true}', "clear history uses backend scope");
  check(skillFixture.data.candidates.length === 2, "pending and generated candidates remain");
  await click(/^技能修订/);
  await click("查看修订历史");
  const revisionChecks = '[aria-label^="选择修订历史："]';
  check(host.querySelectorAll(revisionChecks).length === 2, "only obsolete/rejected revisions are selectable");
  await toggleCheck('[data-history-kind="revision"] .memory-select-all input');
  await click("删除选中（2）"); await dialogClick("确认删除历史");
  await until(() => host.querySelectorAll(revisionChecks).length === 0, "revision multi-delete refreshes list");
  check(JSON.stringify(skillFixture.requests.at(-1)) === '{"kind":"revision","ids":["stale-revision","rejected-revision"]}', "revision selection uses its own scope");
  await click("清空修订历史"); await dialogClick("确认清空历史");
  check(skillFixture.data.revisions.length === 2, "pending and generated revisions survive full cleanup");
  results.push("skill/revision history deletion covers selection, single/full cleanup, cancel/failure, refresh, locking and protection for pending/generated records");

  {
  const learning = learningFixtures(); mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "learning fixture");
  await click("技能学习");
  await until(() => host.querySelectorAll('.skill-review-row').length === 20, "paginated learning queue");
  const chosen = '[aria-label^="选择技能候选："]';
  const selectedCount = () => host.querySelectorAll(`${chosen}:checked`).length;
  const allCandidates = '.skill-review-selection .memory-select-all input';
  check(!host.querySelector<HTMLDetailsElement>('.skill-learning-diagnostics')?.open, "long provider errors are collapsed by default");
  check(host.querySelector('.skill-review-detail')?.textContent?.includes("Git Bash"), "first candidate has readable detail without opening disclosure");
  await toggleCheck(allCandidates);
  check(selectedCount() === 20, "select all is bounded to the current page");
  await clickLabel("下一页候选");
  check(selectedCount() === 0 && host.querySelector('.skill-review-pagination')?.textContent?.includes("21–40"), "paging clears hidden choices");
  await filter("搜索技能候选", "PowerPoint");
  check(host.querySelectorAll('.skill-review-row').length === 9 && host.querySelector('.skill-review-pagination')?.textContent?.includes("1–9"), "search covers all pages and resets pagination");
  await filter("技能适用范围", "workspace");
  check(host.querySelectorAll('.skill-review-row').length === 3, "scope filter combines with search");
  await toggleCheck(allCandidates);
  await filter("技能候选状态", "ready");
  check(host.querySelectorAll('.skill-review-row').length === 2 && selectedCount() === 2, "status filter prunes hidden selections");
  await filter("搜索技能候选", "does-not-exist");
  check(selectedCount() === 0 && host.textContent?.includes("没有匹配的技能"), "empty filter clears selection");
  await click("清除筛选");
  await filter("技能排序", "evidence");
  check(host.querySelector('.skill-review-detail h3')?.textContent?.includes("45"), "evidence ordering prioritizes supported candidates");
  await filter("技能排序", "recent");
  await click("生成技能并继续");
  await until(() => buttons().some((b) => b.textContent === "待处理 44"), "single approval refresh");
  check(buttons().find((b) => b.textContent === "待处理 44")?.getAttribute("aria-pressed") === "true", "approval stays in pending queue");
  check(host.querySelector('.skill-review-detail h3')?.textContent?.includes("· 2"), "approval advances detail to next candidate");
  await toggleCheck(chosen, 0); await toggleCheck(chosen, 1);
  await click("批量生成（2）");
  check(dialog()?.textContent?.includes("默认关闭自动调用") && dialog()?.querySelectorAll("li").length === 2, "batch confirmation identifies candidates and invocation policy");
  await dialogClick("取消");
  check(learning.requests.length === 1 && selectedCount() === 2, "batch cancel preserves choices and sends no mutation");
  const approve = api.memory.approveSkillCandidate;
  const delayedApproval = deferred<any>();
  api.memory.approveSkillCandidate = (id: string) => id === "pending-1" ? delayedApproval.promise : approve(id);
  await click("批量生成（2）"); await dialogClick("确认批量生成");
  check([...host.querySelectorAll<HTMLInputElement>(chosen)].every((item) => item.disabled), "batch locks selection until all results settle");
  check(host.querySelector<HTMLInputElement>('[aria-label="搜索技能候选"]')?.disabled, "batch locks filtering");
  delayedApproval.reject(new Error("来源已变更"));
  await until(() => buttons().some((b) => b.textContent === "待处理 43"), "partial batch success refresh");
  check(selectedCount() === 1 && host.querySelector('[role="status"]')?.textContent?.includes("1 条未成功"), "partial failure retains failed selected row and reports results");
  check(learning.requests.filter((item) => item.action === "approve").map((item) => item.id).join() === "pending-0,pending-2", "batch attempts only confirmed IDs and continues after a failure");
  await click("批量拒绝（1）"); await dialogClick("确认批量拒绝");
  await until(() => buttons().some((b) => b.textContent === "待处理 42"), "batch rejection");
  check(selectedCount() === 0 && learning.items.find((item) => item.id === "pending-1")?.status === "rejected", "batch rejection only changes selected candidate");
  await click(/^技能修订/);
  check(!host.querySelector('.skill-learning-candidates')?.getClientRects().length, "revision section replaces candidate workspace");
  await click(/^使用反馈/);
  check(host.textContent?.includes("尚无已学习技能的使用反馈"), "feedback remains accessible separately");
  results.push("learning queue covers pagination, search/scope/status/sort, continuous approval, bounded batch selection, cancel, busy locking, partial failures and section navigation");
  }
  {
    const organization = organizationFixtures(); mount(<MemoryTab />);
    await until(() => buttons().some(b => b.textContent === "整理全部记忆" && !b.disabled), "organization entry");
    check(host.querySelector<HTMLSelectElement>('[aria-label="筛选记忆状态"]')?.value === "active", "effective memories are the default view");
    await filter("筛选记忆范围", "workspace");
    await click("整理全部记忆");
    check(organization.data.starts.length === 1 && organization.data.starts[0] === undefined, "list filtering never limits whole-store organization");
    check(host.querySelector('progress[aria-label="记忆整理进度"]'), "progress is accessible");
    await click("暂停"); await click("继续整理");
    check(organization.data.starts[1] === "organization-fixture", "resume sends persisted run id");
    organization.data.run = organization.ready(); changed.forEach(fn => fn());
    await until(() => buttons().some(b => b.textContent === "应用 2 项变更"), "completed preview excludes conflict from apply count");
    check(host.querySelectorAll(".memory-organization-proposal").length === 3, "full preview includes changes and conflicts");
    const apply = api.memory.applyOrganization;
    const delayed = deferred(); api.memory.applyOrganization = () => delayed.promise;
    await click("应用 2 项变更");
    check(buttons().find(b => b.textContent === "应用 2 项变更")?.disabled, "apply locks while IPC is pending");
    delayed.reject(new Error("记忆已被修改，请重新整理"));
    await until(() => host.querySelector('[role="alert"]')?.textContent?.includes("记忆已被修改"), "application errors are visible");
    check(organization.data.applied === 0 && host.querySelectorAll(".memory-organization-proposal").length === 3, "failed application keeps preview");
    api.memory.applyOrganization = apply; await click("应用 2 项变更"); await click("撤销整理");
    check(organization.data.applied === 1 && organization.data.undone === 1, "apply and undo use the saved run");
    organization.data.run = organization.ready(); mount(<MemoryTab />);
    await until(() => buttons().some(b => b.textContent === "应用 2 项变更"), "navigation restores saved preview");
    await click("放弃结果");
    check(!host.querySelector(".memory-organization-proposal"), "discard removes preview without mutating facts");
    results.push("whole-store organization ignores browse filters; progress, pause/resume, persisted preview, conflict exclusion, apply failure/busy locking, undo and discard");
  }
  return results;
}

export async function preview(page: "organization" | "organization-narrow" | "memory" | "delete" | "select" | "select-delete" | "scenarios" | "scene-delete" | "scenario-select" | "scenario-select-delete" | "skills" | "skill-history" | "skill-history-delete" | "skill-queue" | "skill-queue-modal" | "settings", dark = false): Promise<void> {
  if (page === "organization" || page === "organization-narrow") { const fixture = organizationFixtures(); fixture.data.run = fixture.ready(); }
  else if (page === "skill-queue" || page === "skill-queue-modal") learningFixtures();
  else if (page === "scenarios" || page === "scene-delete" || page === "scenario-select" || page === "scenario-select-delete") projectionFixtures();
  else if (page === "skill-history" || page === "skill-history-delete") skillHistoryFixtures(); else fixtures();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  mount(<MemoryTab />);
  await until(() => buttons().some((b) => b.textContent === "刷新" && !b.disabled), "preview load");
  if (page === "organization" || page === "organization-narrow") {
    await until(() => buttons().some(b => b.textContent === "查看 3 项变更与冲突"), "organization preview loaded");
    await click("查看 3 项变更与冲突");
    host.querySelector<HTMLDetailsElement>(".memory-organization-proposal")!.open = true;
  } else if (page === "memory" || page === "delete" || page === "select" || page === "select-delete") {
    await click(/^对话来源/);
    await until(() => host.querySelectorAll(".memory-turn-row").length === 2, "preview L0");
    await click(/^对话 A/);
    await until(() => host.querySelector(".memory-turn-detail")?.textContent?.includes("助手原文 A"), "preview selected detail");
    if (page === "delete") await click("删除全部对话来源");
    if (page === "select" || page === "select-delete") await toggleCheck(".memory-select-all input");
    if (page === "select-delete") await click("删除选中（2）");
  } else if (page === "scenarios" || page === "scene-delete" || page === "scenario-select" || page === "scenario-select-delete") {
    await click(/^有效场景/); await click(/^查看过期历史/);
    if (page === "scene-delete") await click("删除全部场景记录");
    if (page === "scenario-select" || page === "scenario-select-delete") await toggleCheck(".memory-projection-toolbar .memory-select-all input");
    if (page === "scenario-select-delete") await click("删除选中（5）");
  } else if (page === "skill-queue" || page === "skill-queue-modal") {
    if (page === "skill-queue-modal") {
      host.className = "settings-backdrop";
      flushSync(() => root!.render(<div className="settings-modal"><nav className="settings-nav"><div className="settings-nav-title">系统设置</div><button className="settings-nav-btn active">记忆</button></nav><div className="settings-content"><div className="settings-content-head"><span className="settings-content-title">记忆</span></div><div className="settings-content-body"><MemoryTab /></div></div></div>));
    }
    await click("技能学习"); await until(() => host.querySelectorAll('.skill-review-row').length === 20, "preview queue");
  } else if (page === "skills") { await click("技能学习"); await until(() => buttons().some((b) => b.textContent === "已生成 1"), "preview skills"); await click("已生成 1"); }
  else if (page === "skill-history" || page === "skill-history-delete") {
    await click("技能学习"); await until(() => buttons().some((b) => b.textContent === "历史记录 3"), "preview skill history");
    await click("历史记录 3"); await toggleCheck('[data-history-kind="candidate"] .memory-select-all input');
    if (page === "skill-history-delete") await click("删除选中（3）");
  }
  else { await click("设置"); await until(() => host.querySelector('[role="switch"][aria-label="使用记忆"]'), "settings preview"); }
  await settle();
}

export function layout(): { width: number; contentWidth: number; columns: string; badges: number } {
  const badges = [...host.querySelectorAll<HTMLElement>(".memory-source")].filter((e) => e.getClientRects().length);
  for (const badge of badges) check(getComputedStyle(badge).whiteSpace === "nowrap", "status badge must not wrap");
  const modal = host.querySelector('.settings-modal');
  const actions = host.querySelector('.skill-review-detail-actions');
  if (modal && actions && window.innerWidth > 800) {
    check(actions.getBoundingClientRect().bottom <= modal.getBoundingClientRect().bottom, "review actions stay within the modal without outer scrolling");
    check(host.querySelector('.skill-review-list')!.clientHeight >= 180, "queue retains usable height at desktop window sizes");
  }
  check(document.documentElement.scrollWidth <= window.innerWidth + 1, "page must not overflow horizontally");
  return { width: window.innerWidth, contentWidth: host.clientWidth, columns: host.querySelector(".memory-split") ? getComputedStyle(host.querySelector(".memory-split")!).gridTemplateColumns : "n/a", badges: badges.length };
}

export function dispose(): void {
  if (root) flushSync(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
}
