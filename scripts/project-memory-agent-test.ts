/**
 * Project Memory → 项目级共享长期认知（回归测试）。
 *
 * 覆盖验收场景：
 *  1. resolver 为项目任务提供受预算的 Memory 摘要（kind/status 计数 + active slice，非全量）；
 *  2. Task A create（来源自动注入 agent+taskId）→ update resolved + create fact → Task B 可见；
 *  3. 跨项目隔离 / 未绑定项目无能力 / readonly / 归档；
 *  4. 主任务（读写桥）与团队/BTW（只读桥）能力面；
 *  5. 100+ 条预算控制 + 单条超预算 skip、后续正常项仍入选；
 *  6. no-op update 不 bump；真实变更 bump；
 *  7. prompt 段读写/只读变体与空记忆变体。
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
  createProjectMemoryExtension,
  type ProjectMemoryExtensionBridge,
} from "../src/main/project/project-memory-extension";
import {
  assembleProjectContextSegments,
} from "../src/main/agent/PromptAssembly";
import {
  PROJECT_MEMORY_ACTIVE_SLICE_MAX_CHARS,
  PROJECT_MEMORY_ACTIVE_SLICE_MAX_ITEMS,
  PROJECT_MEMORY_CONTENT_MAX_CHARS,
  PROJECT_MEMORY_MAX_TAGS,
  PROJECT_MEMORY_TAG_MAX_CHARS,
  PROJECT_MEMORY_TITLE_MAX_CHARS,
  formatProjectMemoryLine,
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
const root = mkdtempSync(join(tmpdir(), "mybuddy-project-memory-agent-"));
const db = new AppDatabase(join(root, "app.db"));
const memory = new MemoryService(db, { semantic: false });
const repository = new ProjectRepository(db.connection);
const service = new ProjectService(repository, memory);
const resolver = new ProjectContextResolver(db, repository, memory);

const projectP = service.create({ name: "仪表销售项目" });
const projectQ = service.create({ name: "另一个项目" });

// P 记忆：客户介质=乙腈(fact)、不用HART(decision)、预算≤8万(constraint)、高温交期未知(open_question)
service.createMemory({ projectId: projectP.id, kind: "fact", title: "客户介质", content: "介质为乙腈，耐腐蚀要求高" }, { sourceType: "agent", sourceTaskId: "task-a" });
service.createMemory({ projectId: projectP.id, kind: "decision", title: "不用HART", content: "客户明确不采用 HART 协议" }, { sourceType: "manual" });
service.createMemory({ projectId: projectP.id, kind: "constraint", title: "预算上限", content: "客户预算不超过 8 万元" });
service.createMemory({ projectId: projectP.id, kind: "open_question", title: "高温版本交期", content: "高温版本交期尚未确认" });

db.upsertTask({ id: "task-a", title: "Task A", updatedAt: 1, projectId: projectP.id, welcomeMode: "coding" });
db.upsertTask({ id: "task-b", title: "Task B", updatedAt: 2, projectId: projectP.id, welcomeMode: "coding" });
db.upsertTask({ id: "task-q", title: "Task Q", updatedAt: 3, projectId: projectQ.id, welcomeMode: "coding" });
db.upsertTask({ id: "task-none", title: "无项目任务", updatedAt: 4, welcomeMode: "coding" });

/* ---------------- 1. One Memory source, no stored prompt duplicate ---------------- */
{
  const ctxA = resolver.resolveTask("task-a");
  assertOk(ctxA != null && !("memorySummary" in ctxA), "resolver: 项目上下文不携带第二份 Memory 摘要");
  const stored = service.listMemory(projectP.id);
  assertOk(stored.length === 4, "memory: 四条真实记录");
  assertOk(stored.filter(m => m.status === "active").length === 4, "memory: active 状态正确");
  const recalled = memory.resolveContext({ taskId: "task-a", query: "客户介质", trackRecall: false });
  assertOk(recalled.items.some(m => m.title === "客户介质"), "projection: 按查询召回当前项目事实");
  assertOk(recalled.includedChars <= recalled.budgetChars, "projection: 有界上下文");
  assertOk(resolver.resolveTask("task-none") === null, "resolver: 未绑定项目任务无项目上下文");
  assertOk(memory.resolveContext({ taskId: "task-q", query: "客户介质", trackRecall: false }).items.length === 0, "projection: 不泄漏其它项目");
}

/* ---------------- 2. Task A 更新 + Task B 接力（验收场景 2/3） ---------------- */
const qId: string = (() => {
  const item = service.listMemory(projectP.id).find((entry) => entry.title === "高温版本交期")!;
  return item.id;
})();
{
  const before = resolver.resolveProject(projectP.id)!.version;
  service.updateMemory({ projectId: projectP.id, id: qId, status: "resolved" });
  const afterResolve = resolver.resolveProject(projectP.id)!.version;
  assertOk(afterResolve > before, "update: Project-scoped L1 变更推进 Project activity/version clock");
  service.createMemory(
    { projectId: projectP.id, kind: "fact", title: "交期", content: "确认交期 4 周" },
    { sourceType: "agent", sourceTaskId: "task-a" },
  );
  // Task B 不依赖 A 聊天历史，看到 A 更新后的摘要
  const ctxB = resolver.resolveTask("task-b")!;
  const storedB = service.listMemory(projectP.id);
  assertOk(storedB.some(m => m.title === "高温版本交期" && m.status === "resolved"), "taskB: 看到已解决记录");
  const recallB = memory.resolveContext({ taskId: "task-b", query: "交期", trackRecall: false });
  assertOk(recallB.items.some(item => item.title === "交期" && item.content.includes("4 周")), "taskB: 召回同项目新事实");

  const manual = service.listMemory(projectP.id).find((entry) => entry.title === "不用HART")!;
  assertOk(manual.sourceType === "manual" && manual.sourceTaskId === undefined, "source: manual 无 taskId");
}

/* ---------------- 3. prompt 装配：Memory 段（读写/只读/空变体） ---------------- */
{
  const ctxA = resolver.resolveTask("task-a")!;
  const segments = assembleProjectContextSegments(ctxA);
  const memSegment = segments.find((s) => s.id === "projectMemory");
  assertOk(memSegment == null, "assembly: 不再注入第二份 Project Memory 摘要");

  const projected = memory.resolveContext({ taskId: "task-a", query: "交期", trackRecall: false });
  assertOk(projected.items.every(item => item.scopeType !== "project" || item.scopeId === projectP.id), "projection: 只召回当前项目范围");

  const roSegments = assembleProjectContextSegments(ctxA, { planReadOnly: true });
  assertOk(!roSegments.some((s) => s.id === "projectMemory"), "assembly: 只读变体同样不重复注入 Memory");

  // 空记忆项目也不生成第二份摘要；统一 Memory Kernel 由独立装配链负责。
  const emptySegments = assembleProjectContextSegments(resolver.resolveTask("task-q"));
  const emptyMem = emptySegments.find((s) => s.id === "projectMemory");
  assertOk(emptyMem == null, "assembly: 空记忆项目不生成重复段");
  const emptyProjection = memory.resolveContext({ taskId: "task-q", query: "交期", trackRecall: false });
  assertOk(!emptyProjection.items.some(item => item.scopeId === projectP.id), "projection: 空项目不继承其它项目记忆");
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

function makeBridge(overrides: Partial<ProjectMemoryExtensionBridge> = {}) {
  const { api, tools } = makeApi();
  const bridge: ProjectMemoryExtensionBridge = {
    taskId: "task-a",
    resolveProjectId: () => projectP.id,
    service,
    getPermissionMode: () => "default",
    ...overrides,
  };
  createProjectMemoryExtension(bridge)(api);
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
    ["project_memory_create", "project_memory_get", "project_memory_list", "project_memory_search", "project_memory_update"],
    "tools: 注册 list/get/search/create/update，不暴露 delete",
  );
}

async function mainTools(): Promise<void> {
/* 4a. list：作用域内读取 + 过滤 */
{
  const { tools } = makeBridge();
  const list = byName(tools, "project_memory_list");
  const all = await list.execute("tc", {} as never);
  assertOk(all.isError === undefined, "list: 项目内读取成功");
  assertOk(all.content[0].text.includes("客户介质"), "list: 文本包含条目");
  assertOk((all.details as { total: number }).total === 5, "list: total=5");
  const decisions = await list.execute("tc", { kind: "decision" } as never);
  assertOk((decisions.details as { total: number }).total === 1, "list: kind 过滤");
  const resolved = await list.execute("tc", { status: "resolved" } as never);
  assertOk((resolved.details as { total: number }).total === 1, "list: status 过滤");
  const query = await list.execute("tc", { query: "乙腈" } as never);
  assertOk((query.details as { total: number }).total === 1, "list: query 搜内容");
}

/* 4b. create：来源自动注入 agent+taskId */
{
  const { tools } = makeBridge();
  const create = byName(tools, "project_memory_create");
  const created = await create.execute("tc", {
    kind: "risk",
    title: "汇率波动",
    content: "报价有效期需覆盖汇率波动",
    tags: ["报价"],
  } as never);
  assertOk(created.isError === undefined, "create: 新增成功");
  const id = (created.details as { item: { id: string } }).item.id;
  assertOk(id.startsWith("mem_"), "create: id 前缀");
  const stored = service.getMemory(projectP.id, id)!;
  assertOk(stored.sourceType === "agent" && stored.sourceTaskId === "task-a", "create: 来源自动注入 taskId");
  assertOk(service.listMemory(projectP.id).some((item) => item.id === id), "create: 数据库立即可见（UI 同路径）");
}

/* 4c. update：单项结构化更新 + superseded 语义 */
{
  const { tools } = makeBridge();
  const update = byName(tools, "project_memory_update");
  const target = service.listMemory(projectP.id).find((item) => item.title === "预算上限")!;
  const updated = await update.execute("tc", { id: target.id, status: "superseded" } as never);
  assertOk(updated.isError === undefined, "update: 单项更新成功");
  assertOk(service.getMemory(projectP.id, target.id)?.status === "superseded", "update: superseded 已落库");
  const notFound = await update.execute("tc", { id: "pmem_nope", status: "resolved" } as never);
  assertOk(notFound.isError === true, "update: 不存在的 id 受控错误");
}

/* 4d. 跨项目隔离（验收场景 4） */
{
  const { tools } = makeBridge({ resolveProjectId: () => projectQ.id });
  const get = await byName(tools, "project_memory_get").execute("tc", { id: qId } as never);
  assertOk(get.isError === true && get.content[0].text.includes("不存在"), "scope: Q 任务不能 get P 的条目且不泄露存在性");
  const update = await byName(tools, "project_memory_update").execute("tc", { id: qId, status: "active" } as never);
  assertOk(update.isError === true, "scope: Q 任务不能 update P 的条目");
  const list = await byName(tools, "project_memory_list").execute("tc", {} as never);
  assertOk((list.details as { total: number }).total === 0, "scope: Q 任务只能看到 Q 自己的记忆");
  const create = await byName(tools, "project_memory_create").execute("tc", { kind: "fact", title: "Q 自己的事实" } as never);
  assertOk(create.isError === undefined, "scope: Q 任务写 Q 自己的记忆允许");
}

/* 4e. 未绑定项目：明确不可用（验收场景 4） */
{
  const { tools } = makeBridge({ resolveProjectId: () => null });
  for (const name of ["project_memory_list", "project_memory_get", "project_memory_create", "project_memory_update"]) {
    const params =
      name === "project_memory_get" ? { id: "x" } : name === "project_memory_update" ? { id: "x", status: "active" } : name === "project_memory_create" ? { kind: "fact", title: "x" } : {};
    const result = await byName(tools, name).execute("tc", params as never);
    assertOk(result.isError === true && result.content[0].text.includes("未绑定"), `scope: 未绑定任务 ${name} 受控错误`);
  }
}

/* 4f. readonly 权限：只读可、写拒绝（团队/BTW 同语义） */
{
  const { tools } = makeBridge({ getPermissionMode: () => "readonly" });
  const create = await byName(tools, "project_memory_create").execute("tc", { kind: "fact", title: "只读新增" } as never);
  assertOk(create.isError === true, "readonly: create 拒绝");
  const update = await byName(tools, "project_memory_update").execute("tc", { id: qId, status: "active" } as never);
  assertOk(update.isError === true, "readonly: update 拒绝");
  const list = await byName(tools, "project_memory_list").execute("tc", {} as never);
  assertOk(list.isError === undefined, "readonly: list 允许");
  const get = await byName(tools, "project_memory_get").execute("tc", { id: qId } as never);
  assertOk(get.isError === undefined, "readonly: get 允许");
}

/* 4g. 归档项目：只读可、写拒绝 */
{
  const { tools } = makeBridge();
  service.archive(projectP.id, true);
  const create = await byName(tools, "project_memory_create").execute("tc", { kind: "fact", title: "归档新增" } as never);
  assertOk(create.isError === true, "archived: create 拒绝");
  const list = await byName(tools, "project_memory_list").execute("tc", {} as never);
  assertOk(list.isError === undefined, "archived: list 允许");
  service.archive(projectP.id, false);
}

/* 5. Query-dependent projection stays bounded with a large persistent store. */
{
  for (let i = 0; i < 110; i++) service.createMemory({ projectId: projectP.id, kind: "fact", title: `批量事实 ${i}`, content: "批量数据不应成为完整系统提示" });
  assertOk(service.listMemory(projectP.id).length >= 110, "bulk: 全量保留在长期存储");
  const projected = memory.resolveContext({ taskId: "task-a", query: "交期", budgetChars: 900, limit: 3, trackRecall: false });
  assertOk(projected.items.length <= 3, "bulk: 召回数量不超限制");
  assertOk(Buffer.byteLength(projected.text, "utf8") <= 900, "bulk: 序列化字节预算不超");
  assertOk(projected.items.every(item => memory.get(item.id)?.status === "active"), "bulk: 已解决或被替代事实不进入默认上下文");
  assertOk(!assembleProjectContextSegments(resolver.resolveTask("task-a")).some(item => item.id === "projectMemory"), "bulk: 不恢复已删除的永久摘要注入");
}

/* 6. no-op update 不 bump；真实变更 bump（验收场景 8） */
{
  const target = service.createMemory({ projectId: projectP.id, kind: "fact", title: "Noop 目标", content: "x" });
  const createdVersion = resolver.resolveProject(projectP.id)!.version;
  const createdUpdatedAt = service.getMemory(projectP.id, target.id)!.updatedAt;
  const noop = service.updateMemory({ projectId: projectP.id, id: target.id, kind: "fact", title: "Noop 目标", content: "x", status: "active", tags: [] });
  assertOk(noop.updatedAt === createdUpdatedAt, "noop: 返回现值 updatedAt 不变");
  assertOk(service.getMemory(projectP.id, target.id)!.updatedAt === createdUpdatedAt, "noop: DB 未写");
  assertOk(resolver.resolveProject(projectP.id)!.version === createdVersion, "noop: 不 bump version");
  service.updateMemory({ projectId: projectP.id, id: target.id, content: "y" });
  assertOk(service.getMemory(projectP.id, target.id)!.updatedAt !== createdUpdatedAt, "noop: 真实变更写库");
  assertOk(resolver.resolveProject(projectP.id)!.version > createdVersion, "noop: 真实 L1 变更推进 Project activity/version clock");
}

/* 6b. 人手删除记忆：条目消失并 bump 项目版本 */
{
  const doomed = service.createMemory({ projectId: projectP.id, kind: "fact", title: "错误沉淀", content: "应删除" });
  const beforeVersion = resolver.resolveProject(projectP.id)!.version;
  const beforeCount = service.listMemory(projectP.id).length;
  service.deleteMemory({ projectId: projectP.id, id: doomed.id });
  assertOk(service.getMemory(projectP.id, doomed.id) === undefined, "delete: 条目消失");
  assertOk(service.listMemory(projectP.id).length === beforeCount - 1, "delete: 列表少 1");
  assertOk(resolver.resolveProject(projectP.id)!.version > beforeVersion, "delete: Project scope detach 推进 Project activity/version clock");
  const afterMissing = service.listMemory(projectP.id).length;
  service.deleteMemory({ projectId: projectP.id, id: "mem_missing" });
  assertOk(service.listMemory(projectP.id).length === afterMissing, "delete: 缺省 id 幂等");
}

/* 7. 数据边界（title/content 长度） */
{
  assert.throws(
    () => service.createMemory({ projectId: projectP.id, kind: "fact", title: "长".repeat(PROJECT_MEMORY_TITLE_MAX_CHARS + 1) }),
    /标题/,
    "boundary: title 超长拒绝",
  );
  const okTitle = service.createMemory({ projectId: projectP.id, kind: "fact", title: "长".repeat(PROJECT_MEMORY_TITLE_MAX_CHARS) });
  assertOk(okTitle.title.length === PROJECT_MEMORY_TITLE_MAX_CHARS, "boundary: title 上限恰好允许");
  assert.throws(
    () => service.createMemory({ projectId: projectP.id, kind: "fact", title: "ok", content: "长".repeat(PROJECT_MEMORY_CONTENT_MAX_CHARS + 1) }),
    /内容/,
    "boundary: content 超长拒绝",
  );
  assert.throws(
    () => service.createMemory({ projectId: projectP.id, kind: "bogus" as never, title: "x" }),
    /类型/,
    "boundary: 非法 kind 拒绝",
  );
  assert.throws(
    () => service.updateMemory({ projectId: projectP.id, id: qId, status: "bogus" as never }),
    /状态/,
    "boundary: 非法 status 拒绝",
  );
}

/* 8. 无 Todo↔Memory 自动映射：todo done 不自动写记忆（无代码路径） */
{
  const todo = service.createTodo({ projectId: projectP.id, title: "报价跟进" });
  const before = service.listMemory(projectP.id).length;
  service.updateTodo({ id: todo.id, status: "done" });
  assertOk(service.listMemory(projectP.id).length === before, "isolation: todo done 不自动产生记忆");
}
}

void mainTools().then(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`project-memory-agent-test: ${failed} FAILED, ${passed} passed`);
    process.exit(1);
  }
  console.log(`project-memory-agent-test: PASS (${passed})`);
});
