/**
 * Project Plan → 项目级共享 Agent 状态（回归测试）。
 *
 * 覆盖验收场景：
 *  1. resolver 为项目任务提供受预算的轻量计划摘要（计数 + active slice，非全量）；
 *  2. todo create/update/delete 驱动项目上下文版本变化（projects.updated_at bump）；
 *  3. prompt 装配包含 Project Plan Context 段（指引 + 预算内摘要；空计划也有简短指引）；
 *  4. project_plan_* 工具：注册面、作用域隔离（跨项目/未绑定/readonly/归档）、
 *     结构化 create/update、日期归一化、持久化立即可见（人类 UI 同读路径）；
 *  5. 显式开始会建立 Plan→Task 关系，但任务完成不自动改计划项；
 *  6. 同项目 Task B 能看到 Task A 经工具更新后的计划。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectContextResolver } from "../src/main/project/ProjectContextResolver";
import {
  createProjectPlanExtension,
  type ProjectPlanExtensionBridge,
} from "../src/main/project/project-plan-extension";
import {
  assembleProjectContextSegments,
  renderProjectPlanContext,
} from "../src/main/agent/PromptAssembly";
import {
  parsePlanDateValue,
  PROJECT_PLAN_ACTIVE_SLICE_MAX_CHARS,
  PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS,
} from "../src/shared/project-domain";

let passed = 0;
let failed = 0;
function assertOk(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

/* ---------------- 环境 ---------------- */
const root = mkdtempSync(join(tmpdir(), "mybuddy-project-plan-agent-"));
const db = new AppDatabase(join(root, "app.db"));
const memory = new MemoryService(db, { semantic: false });
const repository = new ProjectRepository(db.connection);
const service = new ProjectService(repository, memory);
const resolver = new ProjectContextResolver(db, repository, memory);

const projectP = service.create({ name: "仪表销售项目" });
const projectQ = service.create({ name: "另一个项目" });

// P 计划：需求确认(done)、技术选型(doing, high, 临近截止)、报价(todo, high) + 60 个批量项
const doneReq = service.createTodo({ projectId: projectP.id, title: "需求确认", status: "done" });
const doingTech = service.createTodo({
  projectId: projectP.id,
  title: "技术选型",
  status: "doing",
  priority: "high",
  dueAt: new Date(2026, 7, 25).getTime(),
});
service.createTodo({ projectId: projectP.id, title: "报价", status: "todo", priority: "high" });
for (let i = 0; i < 60; i += 1) {
  service.createTodo({ projectId: projectP.id, title: `批量项 ${String(i).padStart(2, "0")}` });
}

db.upsertTask({ id: "task-a", title: "Task A", updatedAt: 1, projectId: projectP.id, welcomeMode: "coding" });
db.upsertTask({ id: "task-b", title: "Task B", updatedAt: 2, projectId: projectP.id, welcomeMode: "coding" });
db.upsertTask({ id: "task-q", title: "Task Q", updatedAt: 3, projectId: projectQ.id, welcomeMode: "coding" });
db.upsertTask({ id: "task-none", title: "无项目任务", updatedAt: 4, welcomeMode: "coding" });

/* ---------------- 1. resolver 轻量摘要 ---------------- */
{
  const ctxA = resolver.resolveTask("task-a");
  assertOk(ctxA?.planSummary != null, "resolver: 项目任务拿到 planSummary");
  assertOk(ctxA!.planSummary!.total === 63, "resolver: total=63");
  assertOk(ctxA!.planSummary!.byStatus.done === 1 && ctxA!.planSummary!.byStatus.doing === 1 && ctxA!.planSummary!.byStatus.todo === 61, "resolver: 状态计数正确");
  assertOk(ctxA!.planSummary!.active.length > 0 && ctxA!.planSummary!.active.length <= PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS, "resolver: active slice ≤ maxItems");
  assertOk(ctxA!.planSummary!.active[0]?.title === "技术选型", "resolver: doing 项排在最前");
  assertOk(ctxA!.planSummary!.active[1]?.title === "报价", "resolver: 高优先 todo 其次");
  assertOk(ctxA!.planSummary!.active.every((t) => t.status !== "done"), "resolver: active slice 不含 done");
  assertOk(ctxA!.planSummary!.budget.includedChars <= PROJECT_PLAN_ACTIVE_SLICE_MAX_CHARS, "resolver: active slice 字符预算内");
  assertOk(resolver.resolveTask("task-none") === null, "resolver: 未绑定项目任务无上下文");
  const ctxQ = resolver.resolveTask("task-q");
  assertOk(ctxQ?.planSummary?.total === 0, "resolver: 另一项目计划独立（空）");
}

/* ---------------- 2. 计划变更驱动上下文版本 ---------------- */
{
  const ctxA = resolver.resolveTask("task-a")!;
  const versionBefore = ctxA.version;
  service.updateTodo({ id: doingTech.id, status: "done" });
  const ctxAfter = resolver.resolveTask("task-a")!;
  assertOk(ctxAfter.version !== versionBefore, "version: todo update 触发版本变化");
  assertOk(ctxAfter.planSummary?.byStatus.done === 2, "version: 更新后计数反映（done=2）");
  service.updateTodo({ id: doingTech.id, status: "doing" });
  assertOk(resolver.resolveTask("task-a")!.version !== ctxAfter.version, "version: 恢复后版本再变");
  const temp = service.createTodo({ projectId: projectP.id, title: "临时项" });
  const versionWithTemp = resolver.resolveProject(projectP.id)!.version;
  service.deleteTodo(temp.id);
  assertOk(resolver.resolveProject(projectP.id)!.version !== versionWithTemp, "version: todo delete 触发版本变化");
  assertOk(service.listTodos(projectP.id).length === 63, "version: 删除已生效");
}

/* ---------------- 3. prompt 装配：Project Plan Context 段 ---------------- */
{
  const ctxA = resolver.resolveTask("task-a")!;
  const segments = assembleProjectContextSegments(ctxA);
  const planSegment = segments.find((s) => s.id === "projectPlan");
  assertOk(planSegment != null, "assembly: 有 projectPlan 段");
  assertOk(planSegment!.content.includes("项目共享计划"), "assembly: 段标题");
  assertOk(planSegment!.content.includes("project_plan_list") && planSegment!.content.includes("project_plan_update"), "assembly: 指引包含工具名");
  assertOk(planSegment!.content.includes("共 63 项"), "assembly: 概况计数");
  assertOk(planSegment!.content.includes("作用域仅限本项目"), "assembly: 项目计划作用域明确");
  assertOk(!/PlanCard|conversation_plan_|conversation_todo_/.test(planSegment!.content), "assembly: 不提示已删除的聊天计划 UI 或工具");
  const idRefs = (planSegment!.content.match(/id=ptodo_/g) ?? []).length;
  assertOk(idRefs > 0 && idRefs <= PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS, "assembly: 只注入预算内 active slice");
  assertOk(planSegment!.chars < 2500, "assembly: 段总长受控");

  const emptySegments = assembleProjectContextSegments(resolver.resolveTask("task-q"));
  const emptyPlan = emptySegments.find((s) => s.id === "projectPlan");
  assertOk(emptyPlan != null && emptyPlan.content.includes("project_plan_create"), "assembly: 空计划项目也有简短指引（Agent 天然知道计划存在）");
}

/* ---------------- 工具注册与执行 ---------------- */
interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (toolCallId: string, params: never) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

function makeApi(): { api: ExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const api = {
    registerTool: (tool: never) => {
      tools.push(tool as unknown as RegisteredTool);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  return { api, tools };
}

function makeBridge(overrides: Partial<ProjectPlanExtensionBridge> = {}) {
  const { api, tools } = makeApi();
  const bridge: ProjectPlanExtensionBridge = {
    taskId: "task-a",
    resolveProjectId: () => projectP.id,
    service,
    getPermissionMode: () => "default",
    ...overrides,
  };
  createProjectPlanExtension(bridge)(api);
  return { bridge, tools };
}

const byName = (tools: RegisteredTool[], name: string): RegisteredTool => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `工具已注册：${name}`);
  return tool!;
};

{
  const { tools } = makeBridge();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    ["project_plan_create", "project_plan_get", "project_plan_list", "project_plan_update"],
    "tools: 注册 list/get/create/update，不暴露 delete",
  );
}

async function main(): Promise<void> {
/* 4a. list：作用域内读取 + 过滤 */
{
  const { tools } = makeBridge();
  const list = byName(tools, "project_plan_list");
  const all = await list.execute("tc", {} as never);
  assertOk(all.isError === undefined, "list: 项目内读取成功");
  assertOk(all.content[0].text.includes("需求确认"), "list: 文本包含计划项");
  assertOk((all.details as { total: number }).total === 63, "list: total=63");
  const doingOnly = await list.execute("tc", { status: "doing" } as never);
  assertOk((doingOnly.details as { total: number }).total === 1, "list: status 过滤");
  const query = await list.execute("tc", { query: "报价" } as never);
  assertOk((query.details as { total: number }).total === 1, "list: query 过滤");
  const limited = await list.execute("tc", { limit: 2 } as never);
  assertOk((limited.details as { items: unknown[] }).items.length === 2, "list: limit 截断");
}

/* 4b. create：结构化新增 + 持久化（人类 UI 同一读路径） */
const createdId: string = await (async () => {
  const { tools } = makeBridge();
  const create = byName(tools, "project_plan_create");
  const created = await create.execute("tc", { title: "确认高温版本交期", status: "todo" } as never);
  assertOk(created.isError === undefined, "create: 新增成功");
  const id = (created.details as { todo: { id: string } }).todo.id;
  assertOk(id.startsWith("ptodo_"), "create: id 前缀");
  assertOk(service.listTodos(projectP.id).some((t) => t.id === id), "create: 数据库立即可见（UI 同路径）");
  return id;
})();

/* 4c. update：单项结构化更新（验收场景 2：技术选型 → done） */
{
  const { tools } = makeBridge();
  const update = byName(tools, "project_plan_update");
  const updated = await update.execute("tc", { id: doingTech.id, status: "done" } as never);
  assertOk(updated.isError === undefined, "update: 单项更新成功");
  assertOk(service.getTodo(doingTech.id)?.status === "done", "update: 数据库已改为 done");
  const notFound = await update.execute("tc", { id: "ptodo_nope", status: "done" } as never);
  assertOk(notFound.isError === true, "update: 不存在的 id 受控错误");
}

/* 4d. 日期归一化与清除 */
{
  const { tools } = makeBridge();
  const create = byName(tools, "project_plan_create");
  const withDates = await create.execute("tc", {
    title: "带日期项",
    startAt: "2026-08-20",
    dueAt: 1780000000000,
  } as never);
  assertOk(withDates.isError === undefined, "date: 创建成功");
  const dt = (withDates.details as { todo: { id: string; startAt: number; dueAt: number } }).todo;
  assertOk(dt.startAt === new Date(2026, 7, 20).getTime(), "date: YYYY-MM-DD → 当地 0 点 ms");
  assertOk(dt.dueAt === 1780000000000, "date: 毫秒时间戳透传");
  const bad = await create.execute("tc", { title: "坏日期", dueAt: "2026-13-99" } as never);
  assertOk(bad.isError === true, "date: 非法日期受控错误");
  const update = byName(tools, "project_plan_update");
  const cleared = await update.execute("tc", { id: dt.id, startAt: null } as never);
  assertOk(cleared.isError === undefined, "date: 清除成功");
  assertOk(service.getTodo(dt.id)?.startAt === undefined, "date: startAt 已清除");
}

/* 4e. 跨项目隔离（验收场景 4：Q 的任务不能读写 P 的计划） */
{
  const { tools } = makeBridge({ resolveProjectId: () => projectQ.id });
  const get = await byName(tools, "project_plan_get").execute("tc", { id: doingTech.id } as never);
  assertOk(get.isError === true && get.content[0].text.includes("不属于"), "scope: Q 任务不能 get P 的计划项");
  const update = await byName(tools, "project_plan_update").execute("tc", { id: doingTech.id, status: "todo" } as never);
  assertOk(update.isError === true, "scope: Q 任务不能 update P 的计划项");
  const list = await byName(tools, "project_plan_list").execute("tc", {} as never);
  assertOk((list.details as { total: number }).total === 0, "scope: Q 任务只能看到 Q 自己的计划");
  const create = await byName(tools, "project_plan_create").execute("tc", { title: "Q 自己的事项" } as never);
  assertOk(create.isError === undefined, "scope: Q 任务写 Q 自己的计划允许");
  assertOk(service.listTodos(projectQ.id).length === 1, "scope: Q 计划已写入");
}

/* 4f. 未绑定项目：明确不可用（验收场景 4） */
{
  const { tools } = makeBridge({ resolveProjectId: () => null });
  for (const name of ["project_plan_list", "project_plan_get", "project_plan_create", "project_plan_update"]) {
    const params =
      name === "project_plan_get" ? { id: "x" } : name === "project_plan_update" ? { id: "x", status: "done" } : name === "project_plan_create" ? { title: "x" } : {};
    const result = await byName(tools, name).execute("tc", params as never);
    assertOk(result.isError === true && result.content[0].text.includes("未绑定"), `scope: 未绑定任务 ${name} 受控错误`);
  }
}

/* 4g. readonly 权限：只读可、写拒绝 */
{
  const { tools } = makeBridge({ getPermissionMode: () => "readonly" });
  const create = await byName(tools, "project_plan_create").execute("tc", { title: "只读新增" } as never);
  assertOk(create.isError === true, "readonly: create 拒绝");
  const update = await byName(tools, "project_plan_update").execute("tc", { id: doingTech.id, status: "doing" } as never);
  assertOk(update.isError === true, "readonly: update 拒绝");
  const list = await byName(tools, "project_plan_list").execute("tc", {} as never);
  assertOk(list.isError === undefined, "readonly: list 允许");
}

/* 4h. 归档项目：只读可、写拒绝（与人类 UI 一致） */
{
  const { tools } = makeBridge();
  service.archive(projectP.id, true);
  const create = await byName(tools, "project_plan_create").execute("tc", { title: "归档新增" } as never);
  assertOk(create.isError === true, "archived: create 拒绝");
  const update = await byName(tools, "project_plan_update").execute("tc", { id: createdId, status: "done" } as never);
  assertOk(update.isError === true, "archived: update 拒绝");
  const list = await byName(tools, "project_plan_list").execute("tc", {} as never);
  assertOk(list.isError === undefined, "archived: list 允许");
  service.archive(projectP.id, false);
}

/* 5. 无状态强绑定：任务完成不自动改计划（验收场景 5） */
{
  db.upsertTask({ id: "task-a", title: "Task A", updatedAt: Date.now(), projectId: projectP.id, status: "completed" });
  const ctx = resolver.resolveTask("task-a")!;
  assertOk(ctx.planSummary?.byStatus.done === 2, "human-todo: 任务完成不自动把计划项置 done（无绑定/自动映射）");
}

/* 6. 同项目 Task B 看到 Task A 更新后的计划（验收场景 3） */
{
  const ctxB = resolver.resolveTask("task-b")!;
  assertOk(ctxB.planSummary?.total === 65, "taskB: 计划总数含 Task A 新增（63+确认高温版本交期+带日期项）");
  assertOk(ctxB.planSummary?.byStatus.done === 2, "taskB: 看到 Task A 把技术选型置 done");
  assertOk(ctxB.planSummary?.byStatus.todo === 63, "taskB: 新增项计数");
  assertOk(ctxB.planSummary?.active.some((t) => t.title === "确认高温版本交期") === true, "taskB: active slice 含 Task A 新增项");
  const { tools } = makeBridge();
  const list = await byName(tools, "project_plan_list").execute("tc", { status: "done" } as never);
  assertOk((list.details as { total: number }).total === 2, "taskB: 工具读到最新 done 项");
}

/* 收口 B. 日期 round-trip 严格校验：2026-02-30/2026-04-31 拒绝，闰年接受，null/ms 语义保留 */
{
  assert.throws(() => parsePlanDateValue("2026-02-30"), /日期越界/, "date: 2026-02-30 拒绝");
  assert.throws(() => parsePlanDateValue("2026-04-31"), /日期越界/, "date: 2026-04-31 拒绝");
  assert.throws(() => parsePlanDateValue("2026-13-01"), /日期越界/, "date: 2026-13-01 拒绝");
  assert.throws(() => parsePlanDateValue("2026-00-10"), /日期越界/, "date: 2026-00-10 拒绝");
  assert.equal(parsePlanDateValue("2028-02-29"), new Date(2028, 1, 29).getTime(), "date: 2028-02-29 闰年接受");
  assert.equal(parsePlanDateValue("2026-08-20"), new Date(2026, 7, 20).getTime(), "date: 合法日期当地 0 点");
  assert.equal(parsePlanDateValue(null), null, "date: null 清除语义保留");
  assert.equal(parsePlanDateValue(undefined), undefined, "date: undefined 不涉及");
  assert.equal(parsePlanDateValue(1780000000000), 1780000000000, "date: ms 时间戳透传");
  assert.throws(() => parsePlanDateValue(Number.NaN), /日期/, "date: NaN 拒绝");
  // 工具路径同样拒绝/接受
  const { tools } = makeBridge();
  const create = byName(tools, "project_plan_create");
  const bad = await create.execute("tc", { title: "坏日期工具", dueAt: "2026-02-30" } as never);
  assertOk(bad.isError === true, "date: 工具路径 2026-02-30 拒绝");
  const leap = await create.execute("tc", { title: "闰年工具", dueAt: "2028-02-29" } as never);
  assertOk(
    leap.isError === undefined &&
      (leap.details as { todo: { dueAt: number } }).todo.dueAt === new Date(2028, 1, 29).getTime(),
    "date: 工具路径 2028-02-29 接受",
  );
}

/* 收口 C. title ≤500 数据边界（service 层强制，任何入口不可绕过） */
{
  const longTitle = "长".repeat(501);
  assert.throws(() => service.createTodo({ projectId: projectP.id, title: longTitle }), /500/, "title: create 501 拒绝");
  assert.throws(
    () => service.createTodo({ projectId: projectP.id, title: ` ${longTitle}` }),
    /500/,
    "title: trim 后 501 也拒绝",
  );
  const ok500 = service.createTodo({ projectId: projectP.id, title: "长".repeat(500) });
  assertOk(ok500.title.length === 500, "title: create 500 恰好允许");
  assert.throws(() => service.updateTodo({ id: ok500.id, title: longTitle }), /500/, "title: update 501 拒绝");
  const upd500 = service.updateTodo({ id: ok500.id, title: "长".repeat(500) });
  assertOk(upd500.title.length === 500, "title: update 500 恰好允许");
}

/* 收口 D. no-op update：不改 updatedAt、不 bump project version；真实变更仍 bump */
{
  const target = service.createTodo({ projectId: projectP.id, title: "Noop 目标", status: "doing" });
  const createdVersion = resolver.resolveProject(projectP.id)!.version;
  const createdUpdatedAt = service.getTodo(target.id)!.updatedAt;
  // 完全相同 patch（null 清除语义：当前无 description/assignee/priority/startAt/dueAt，tags 空）
  const noop = service.updateTodo({
    id: target.id,
    status: "doing",
    description: null,
    assignee: null,
    priority: null,
    startAt: null,
    dueAt: null,
    tags: [],
  });
  assert.equal(noop.updatedAt, createdUpdatedAt, "noop: 返回现值 updatedAt 不变");
  assert.equal(service.getTodo(target.id)!.updatedAt, createdUpdatedAt, "noop: DB 未写");
  assert.equal(resolver.resolveProject(projectP.id)!.version, createdVersion, "noop: 不 bump project version");
  // tags 同序同值 → no-op；顺序不同 → 真实变更
  service.updateTodo({ id: target.id, tags: ["x", "y"] });
  const tagsV1 = resolver.resolveProject(projectP.id)!.version;
  const tagsU1 = service.getTodo(target.id)!.updatedAt;
  service.updateTodo({ id: target.id, tags: ["x", "y"] });
  assert.equal(service.getTodo(target.id)!.updatedAt, tagsU1, "noop: tags 同值不改 updatedAt");
  assert.equal(resolver.resolveProject(projectP.id)!.version, tagsV1, "noop: tags 同值不 bump");
  service.updateTodo({ id: target.id, tags: ["y", "x"] });
  assert.notEqual(service.getTodo(target.id)!.updatedAt, tagsU1, "noop: tags 顺序变化是真实变更");
  // title 首尾空格 → trim 后同值 → no-op
  const u2 = service.getTodo(target.id)!.updatedAt;
  service.updateTodo({ id: target.id, title: "  Noop 目标  " });
  assert.equal(service.getTodo(target.id)!.updatedAt, u2, "noop: title trim 后同值不改");
  // 真实变更仍 bump
  const v2 = resolver.resolveProject(projectP.id)!.version;
  service.updateTodo({ id: target.id, status: "done" });
  assert.notEqual(resolver.resolveProject(projectP.id)!.version, v2, "noop: 真实变更仍 bump");
}

/* 收口 E. 单条超预算 active 项被 skip，后续正常 doing/high 项仍在，预算不超 */
{
  const huge = service.createTodo({
    projectId: projectP.id,
    title: "超长项",
    status: "doing",
    assignee: "负责人".repeat(600), // line 远超 MAX_CHARS，且 doing 排序最前
  });
  const normal = service.createTodo({
    projectId: projectP.id,
    title: "正常进行项",
    status: "doing",
    priority: "high",
  });
  const summary = resolver.resolveProject(projectP.id)!.planSummary!;
  assertOk(!summary.active.some((t) => t.id === huge.id), "slice: 超长项被 skip");
  assertOk(summary.active.some((t) => t.id === normal.id), "slice: 后续正常 doing/high 项仍在");
  assertOk(summary.active.length <= PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS, "slice: 仍遵守 MAX_ITEMS");
  assertOk(summary.budget.includedChars <= PROJECT_PLAN_ACTIVE_SLICE_MAX_CHARS, "slice: 预算不超");
}

/* 收口 A. 只读渲染变体：指引与能力面一致（团队/BTW 用 writable=false） */
{
  const ctxA = resolver.resolveTask("task-a")!;
  const summary = ctxA.planSummary!;
  const writable = renderProjectPlanContext(summary, true);
  assertOk(writable.includes("project_plan_list") && writable.includes("project_plan_update") && writable.includes("project_plan_create"), "render: 主任务读写指引含全部工具名");
  const readOnly = renderProjectPlanContext(summary, false);
  assertOk(readOnly.includes("project_plan_list") && readOnly.includes("project_plan_get"), "render: 只读指引含 list/get");
  assertOk(!readOnly.includes("project_plan_create") && !readOnly.includes("project_plan_update"), "render: 只读指引不含 create/update 工具名");
  assertOk(readOnly.includes("只读"), "render: 只读指引明确只读");
  // assembleProjectContextSegments 传 planReadOnly 生效
  const roSegments = assembleProjectContextSegments(ctxA, { planReadOnly: true });
  const roPlan = roSegments.find((s) => s.id === "projectPlan")!;
  assertOk(roPlan.content.includes("只读") && !roPlan.content.includes("project_plan_create"), "assembly: planReadOnly 渲染只读变体");
  // 空计划只读变体（BTW/团队在无计划项目同样一致）
  const emptySummary = resolver.resolveTask("task-q")!.planSummary!;
  const roEmpty = renderProjectPlanContext(emptySummary, false);
  assertOk(roEmpty.includes("只读") && !roEmpty.includes("project_plan_create"), "render: 空计划只读变体一致");
  assertOk(renderProjectPlanContext(emptySummary, true).includes("project_plan_create"), "render: 空计划读写变体含 create");
}
}

void main().then(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`project-plan-agent-test: ${failed} FAILED, ${passed} passed`);
    process.exit(1);
  }
  console.log(`project-plan-agent-test: PASS (${passed})`);
});
