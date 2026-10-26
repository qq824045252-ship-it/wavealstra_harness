import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-agent-"));
process.env.USERPROFILE = root;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy"), { recursive: true });
writeFileSync(
  join(root, ".mybuddy", "mcp.json"),
  JSON.stringify({
    mcpServers: {
      serena: { command: "node", args: ["--version"], modes: ["coding"] },
      "background-denied": { command: "node", args: ["--version"], modes: ["coding"] },
    },
  }),
  "utf8",
);

const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { AgentService } = await import("../src/main/agent/AgentService");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { ProjectRepository } = await import("../src/main/project/ProjectRepository");
const { ProjectService } = await import("../src/main/project/ProjectService");
const { MemoryService } = await import("../src/main/memory/MemoryService");
// 真实 SessionManager/SettingsManager：bindSessionModelAdmission 与 legacy memory 重建会直接使用
// session.sessionManager / session.settingsManager 的完整接口，手写最小 fake 会随实现演进而漏方法。
const { SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
type AgentUiPatch = import("../src/shared/agent-ipc").AgentUiPatch;
type CreateAgentSessionOptions = import("@earendil-works/pi-coding-agent").CreateAgentSessionOptions;
type CreateAgentSessionResult = import("@earendil-works/pi-coding-agent").CreateAgentSessionResult;

const db = new AppDatabase(join(root, "app.db"));
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));
const project = projects.create({
  name: "Runtime integration",
  instructions: "Project instructions reach the real prompt path.",
  policies: {
    expert: { allow: [], deny: ["blocked-expert"], recommended: [] },
    connector: { allow: [], deny: ["blocked-connector"], recommended: [] },
    mcp: { mode: "hard", allow: [], deny: ["serena", "background-denied"] },
  },
});
const liveResourcePath = join(root, "runtime-resource.md");
writeFileSync(liveResourcePath, "resource revision one", "utf8");
projects.createResource({
  projectId: project.id,
  kind: "file",
  title: "Live runtime resource",
  value: liveResourcePath,
});
db.upsertTask({
  id: "runtime-task",
  title: "Runtime",
  updatedAt: 1,
  projectId: project.id,
  welcomeMode: "coding",
});

let submittedPrompt = "";
let sdkCalls = 0;
let assembledAppendParts: string[] = [];
const assembledCalls: string[][] = [];
/** 每次 createSession 调用记录能力面：tools 白名单 + 已注册扩展工具名（P1 收口断言用） */
const seenSessions: Array<{
  tools: string[] | undefined;
  extensionToolNames: string[];
  append: string[];
}> = [];
const fakeSession = {
  isStreaming: false,
  model: undefined,
  messages: [],
  sessionFile: join(root, "runtime-session.jsonl"),
  // bindSessionModelAdmission(session) 需要这些成员：
  //   sessionManager 作为 WeakMap 键（未定义会抛 "Invalid value used as weak map key"）且被 legacy
  //   memory 重建调用 getBranch/getEntry/...；settingsManager 作为默认 admissionSettings。
  // 用真实实现而非手写 fake，避免实现演进后漏方法。
  sessionManager: SessionManager.inMemory(root),
  settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
  agent: { streamFunction: () => {} },
  compact: async () => {},
  navigateTree: async () => {},
  // bindLegacyMemoryHistory 还会包装 abort / abortCompaction / refreshContext。
  abort: async () => {},
  abortCompaction: () => {},
  refreshContext: () => {},
  prompt: async (text: string) => {
    submittedPrompt = text;
  },
  getLastAssistantText: () => "[]",
  setModel: async () => {},
  setThinkingLevel: () => {},
  getContextUsage: () => null,
  bindExtensions: async () => {},
  subscribe: () => () => {},
  dispose: () => {},
  getActiveToolNames: () => [],
  getAllTools: () => [],
  setActiveToolsByName: () => {},
};
const createSessionAtSdkBoundary = async (
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> => {
  sdkCalls += 1;
  assembledAppendParts = options.resourceLoader?.getAppendSystemPrompt() ?? [];
  assembledCalls.push(assembledAppendParts);
  seenSessions.push({
    tools: options.tools as string[] | undefined,
    extensionToolNames:
      (options.resourceLoader?.getExtensions?.()?.extensions ?? []).flatMap((extension) =>
        [...(extension.tools?.keys?.() ?? [])],
      ) ?? [],
    append: assembledAppendParts,
  });
  return {
    session: fakeSession as unknown as CreateAgentSessionResult["session"],
    extensionsResult: {
      extensions: [],
      errors: [],
      runtime: {},
    } as unknown as CreateAgentSessionResult["extensionsResult"],
  };
};

const agent = new AgentService(
  db,
  new TaskExecutionWorkspace(join(root, "task-workspaces")),
  { createAgentSession: createSessionAtSdkBoundary },
);
const baseProfile = agent.getModeProfile("coding");
agent.saveModePolicy("coding", {
  ...baseProfile.policy,
  presets: [
    ...(baseProfile.policy.presets ?? []),
    {
      id: "required-mcp-test",
      label: "Required MCP Test",
      providerMcpIds: ["serena"],
      mcpPolicy: { mode: "hard", allow: ["serena"], deny: [] },
    },
  ],
});
db.upsertTask({
  id: "runtime-task",
  title: "Runtime",
  updatedAt: 2,
  projectId: project.id,
  welcomeMode: "coding",
  modePresetId: "required-mcp-test",
  expertId: "blocked-expert",
});
agent.setTaskConnectorIds("runtime-task", ["blocked-connector"]);

const patches: AgentUiPatch[] = [];
const unsubscribe = agent.onPatch((patch) => patches.push(patch));

try {
  const inspection = agent.inspectRuntimeContext("runtime-task");
  assert.equal(sdkCalls, 0, "Inspector must not create an Agent session");
  assert.equal(inspection.basis, "current_configuration");
  assert.equal(inspection.effectiveAt, "next_resolution");
  assert.equal(inspection.project?.id, project.id);
  assert.equal(inspection.tag?.id, "required-mcp-test");
  assert.equal(
    inspection.instructions.find((segment) => segment.id === "project")?.sourceId,
    project.id,
  );
  assert.equal(
    inspection.capabilities.find((item) => item.kind === "expert")?.reason,
    "project_policy_denied",
  );
  assert.equal(
    inspection.capabilities.find((item) => item.kind === "connector")?.reason,
    "project_policy_denied",
  );
  assert.equal(
    inspection.capabilities.find((item) => item.id === "background-denied")?.reason,
    "project_policy_denied",
    "Inspector must include exhaustive background MCP diagnostics",
  );

  const preview = agent.assembleModePreview({
    welcomeMode: "coding",
    projectId: project.id,
    modePresetId: "required-mcp-test",
    expertId: "blocked-expert",
    connectorIds: ["blocked-connector"],
    cwd: root,
  });
  assert.equal(preview.segments.find((segment) => segment.id === "project")?.sourceId, project.id);
  assert.equal(
    preview.capabilities?.find((item) => item.kind === "expert")?.reason,
    "project_policy_denied",
  );
  assert.equal(
    preview.capabilities?.find((item) => item.kind === "connector")?.reason,
    "project_policy_denied",
  );
  assert.equal(
    preview.capabilities?.find((item) => item.kind === "mcp" && item.id === "serena")?.reason,
    "project_policy_denied",
  );

  const result = await agent.prompt({
    taskId: "runtime-task",
    text: "run",
    assistantMessageId: "assistant-1",
    userMessageId: "user-1",
    welcomeMode: "coding",
    modePresetId: "required-mcp-test",
    expertId: "blocked-expert",
    connectorIds: ["blocked-connector"],
  });
  assert.equal(result.queued, false);
  assert.equal(sdkCalls, 1, "The real AgentService.createSession path must reach the SDK seam once");
  assert.ok(
    assembledAppendParts.some((part) => part.includes(project.instructions ?? "")),
    "Project instructions must reach DefaultResourceLoader through real createSession assembly",
  );
  assert.equal(agent.registry.get("runtime-task")?.expertId, undefined);
  assert.deepEqual(agent.registry.get("runtime-task")?.connectorIds, ["blocked-connector"]);
  assert.equal(submittedPrompt, "run");
  const snapshots = agent.listRuntimeContextSnapshots("runtime-task");
  assert.equal(snapshots.length, 1, "Accepted prompt must persist one immutable runtime snapshot");
  assert.equal(snapshots[0]?.projectId, project.id);
  assert.equal(snapshots[0]?.projectUpdatedAt, projects.get(project.id)?.updatedAt);
  assert.equal(snapshots[0]?.status, "completed");
  assert.ok(snapshots[0]?.assemblyHash);
  assert.ok(snapshots[0]?.resolvedInstructions.some((segment) => segment.content.includes(project.instructions ?? "")));
  assert.equal(
    snapshots[0]?.resolvedCapabilities.find((item) => item.kind === "expert")?.reason,
    "project_policy_denied",
    "Execution audit must preserve the rejected requested Expert decision",
  );
  writeFileSync(liveResourcePath, "resource revision two", "utf8");
  await agent.prompt({
    taskId: "runtime-task",
    text: "run after file resource change",
    assistantMessageId: "assistant-resource-2",
    userMessageId: "user-resource-2",
    welcomeMode: "coding",
    modePresetId: "required-mcp-test",
    expertId: "blocked-expert",
    connectorIds: ["blocked-connector"],
  });
  assert.equal(sdkCalls, 2, "File resource content change must recreate the runtime session");
  const changedSnapshot = agent.listRuntimeContextSnapshots("runtime-task")[0];
  assert.notEqual(changedSnapshot?.assemblyHash, snapshots[0]?.assemblyHash);
  assert.ok(changedSnapshot?.resolvedInstructions.some((segment) => segment.content.includes("resource revision two")));
  projects.update({ id: project.id, instructions: "Changed after execution" });
  assert.ok(
    snapshots[0]?.resolvedInstructions.some((segment) =>
      segment.content.includes(project.instructions ?? ""),
    ),
    "Project edits must not rewrite historical runtime snapshots",
  );

  const notice = patches.find((patch) => patch.type === "capability_notices");
  assert.ok(notice && notice.notices.length === 3);
  if (notice?.type === "capability_notices") {
    assert.deepEqual(
      notice.notices.map((item) => [item.kind, item.reason, item.source]),
      [
        ["expert", "project_policy_denied", "project"],
        ["connector", "project_policy_denied", "project"],
        ["mcp", "project_policy_denied", "project"],
      ],
    );
    assert.equal(
      notice.notices.some((item) => item.id === "background-denied"),
      false,
      "Background MCP filtering belongs in Inspector and must not create chat banner noise",
    );
  }

  db.upsertTask({ id: "no-project-task", title: "No Project", updatedAt: 1, welcomeMode: "coding" });
  const noProjectResult = await agent.prompt({
    taskId: "no-project-task",
    text: "no project",
    assistantMessageId: "assistant-2",
    userMessageId: "user-2",
    welcomeMode: "coding",
  });
  assert.equal(noProjectResult.queued, false);
  assert.equal(sdkCalls, 3);
  assert.equal(
    assembledCalls[2].some((part) => part.includes(project.instructions ?? "")),
    false,
    "No-Project Task must preserve the previous assembly behavior",
  );
  const noProjectNotice = patches.find(
    (patch) => patch.type === "capability_notices" && patch.taskId === "no-project-task",
  );
  assert.ok(noProjectNotice?.type === "capability_notices" && noProjectNotice.notices.length === 0);
  assert.equal(agent.listRuntimeContextSnapshots("no-project-task")[0]?.projectId, undefined);
  db.deleteTask("no-project-task");
  assert.equal(
    (db.connection.prepare("SELECT count(*) AS count FROM task_runtime_context_snapshots WHERE task_id = ?").get("no-project-task") as { count: number }).count,
    0,
    "Task purge must cascade runtime snapshots",
  );

  db.upsertTask({ id: "global-gate-task", title: "Global gate", updatedAt: 1, welcomeMode: "coding", expertId: "missing-expert" });
  agent.setTaskConnectorIds("global-gate-task", ["missing-connector"]);
  const globalInspection = agent.inspectRuntimeContext("global-gate-task");
  assert.equal(
    globalInspection.capabilities.find((item) => item.kind === "expert")?.reason,
    "global_disabled",
  );
  assert.equal(
    globalInspection.capabilities.find((item) => item.kind === "connector")?.reason,
    "global_disabled",
  );
  await agent.prompt({
    taskId: "global-gate-task",
    text: "global gate",
    assistantMessageId: "assistant-3",
    userMessageId: "user-3",
    welcomeMode: "coding",
    expertId: "missing-expert",
    connectorIds: ["missing-connector"],
  });
  const globalSnapshot = agent.listRuntimeContextSnapshots("global-gate-task")[0];
  assert.equal(
    globalSnapshot?.resolvedCapabilities.find((item) => item.kind === "expert")?.reason,
    "global_disabled",
    "Actual execution and Inspector must share the Expert availability decision",
  );
  assert.equal(
    globalSnapshot?.resolvedCapabilities.find((item) => item.kind === "connector")?.reason,
    "global_disabled",
    "Actual execution and Inspector must share the Connector availability decision",
  );

  projects.createResource({
    projectId: project.id,
    kind: "text",
    title: "Shared context",
    value: "Auxiliary executions must receive this Project Resource.",
  });
  projects.createTodo({
    projectId: project.id,
    title: "Read-only plan item",
    status: "doing",
  });
  projects.createMemory({
    projectId: project.id,
    kind: "decision",
    title: "Shared decision",
    content: "Auxiliary execution must see this project memory.",
  });

  /* ---- P1 收口：计划/记忆能力面与指引一致性（真实 createSession 路径） ---- */
  const planToolNames = [
    "project_plan_list",
    "project_plan_get",
    "project_plan_create",
    "project_plan_update",
  ];
  const memoryToolNames = [
    "memory_search",
    "memory_get",
    "memory_create",
    "memory_update",
    "memory_promote",
    "memory_history",
  ];
  const readOnlyWhitelist = [
    "read",
    "grep",
    "find",
    "ls",
    "project_plan_list",
    "project_plan_get",
    "memory_search",
    "memory_get",
    "memory_history",
  ];
  // 0/1: runtime-task 主任务会话（绑项目）→ 注册全部 4+4 工具（读写能力面）
  assert.ok(
    seenSessions[0] &&
      planToolNames.every((name) => seenSessions[0]!.extensionToolNames.includes(name)) &&
      memoryToolNames.every((name) => seenSessions[0]!.extensionToolNames.includes(name)),
    "Main task session registers project plan + unified memory tools",
  );
  assert.equal(seenSessions[0]?.tools, undefined, "Main task session keeps default (unrestricted) tool surface");
  // 2: no-project-task / 3: global-gate-task（未绑定项目）→ 不注入 plan/memory 工具
  for (const index of [2, 3]) {
    assert.ok(
      seenSessions[index] &&
        planToolNames.every((name) => !seenSessions[index]!.extensionToolNames.includes(name)) &&
        memoryToolNames.every((name) => seenSessions[index]!.extensionToolNames.includes(name)),
      `Unbound task session (index ${index}) keeps Memory Kernel but no project plan tools`,
    );
  }
  // BTW 瞬时会话（inMemory，父任务绑项目）→ 同样只读能力面 + 只读指引
  await agent.startBtw({ btwId: "btw-plan-test", parentTaskId: "runtime-task" });
  const btwSession = seenSessions[seenSessions.length - 1];
  assert.deepEqual(
    btwSession?.tools,
    readOnlyWhitelist,
    "BTW transient session whitelist is read-only plan+memory surface",
  );
  assert.ok(
    btwSession?.append.some(
      (part) =>
        part.includes("项目共享计划") &&
        part.includes("只读") &&
        !part.includes("project_plan_create") &&
        !part.includes("project_plan_update"),
    ),
    "BTW plan guidance is the read-only variant (consistent with its tool surface)",
  );
  /* ---- 收口 P2 回归：父任务解绑 Project 后，BTW 不再残留旧装配的读写计划/记忆指引 ---- */
  db.upsertTask({ id: "runtime-task", title: "Runtime", updatedAt: Date.now(), projectId: null });
  await agent.startBtw({ btwId: "btw-unbound-test", parentTaskId: "runtime-task" });
  const unboundBtw = seenSessions[seenSessions.length - 1];
  assert.deepEqual(
    unboundBtw?.tools,
    ["read", "grep", "find", "ls"],
    "BTW after project unbind has no plan/memory tools in whitelist",
  );
  assert.ok(
    unboundBtw?.extensionToolNames.every(
      (name) => !name.startsWith("project_plan_") && !name.startsWith("memory_"),
    ),
    "BTW after project unbind registers no plan/memory extension",
  );
  assert.ok(
    !unboundBtw?.append.some(
      (part) => part.includes("项目共享计划") || part.includes("项目共享记忆"),
    ),
    "BTW after project unbind has no projectPlan/projectMemory guidance segments",
  );
  assert.ok(
    !unboundBtw?.append.some(
      (part) =>
        part.includes("project_plan_create") ||
        part.includes("project_plan_update") ||
        part.includes("memory_create") ||
        part.includes("memory_update"),
    ),
    "BTW after project unbind must not advertise plan/memory write tools",
  );
  assert.ok(
    unboundBtw?.append.some((part) => part.includes("当前任务工作目录")),
    "BTW after project unbind keeps other context segments",
  );
  console.log("PASS  Project real createSession/prompt assembly and policy notices");
} finally {
  unsubscribe();
  agent.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
