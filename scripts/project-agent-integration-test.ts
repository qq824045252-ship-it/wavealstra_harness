import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-agent-"));
process.env.USERPROFILE = root;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });
writeFileSync(
  join(root, ".mybuddy", "plugins", "mcp", "mcp.json"),
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
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
type AgentUiPatch = import("../src/shared/agent-ipc").AgentUiPatch;

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

const fixture = await createAgentDurableFixture(root, db);
const { agent, requests } = fixture;
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
  assert.equal(requests.length, 0, "Inspector must not invoke a model");
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

  const request = { taskId: "runtime-task", text: "run", assistantMessageId: "assistant-1", userMessageId: "user-1",
    welcomeMode: "coding" as const, modePresetId: "required-mcp-test", expertId: "blocked-expert", connectorIds: ["blocked-connector"] };
  await fixture.prompt(request);
  assert.equal(requests.length, 1);
  assert(requests[0]!.instructions.includes(project.instructions!));
  const snapshots = agent.listRuntimeContextSnapshots("runtime-task");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.status, "completed");
  assert.equal(snapshots[0]?.projectId, project.id);
  assert(snapshots[0]?.resolvedInstructions.some(segment => segment.content.includes(project.instructions!)));
  const beforeHistory = await agent.loadTaskHistory("runtime-task");
  writeFileSync(liveResourcePath, "resource revision two", "utf8");
  await fixture.prompt({ ...request, text: "run after resource change", assistantMessageId: "assistant-2", userMessageId: "user-2" });
  assert.equal(requests.length, 2);
  assert.equal((await agent.loadTaskHistory("runtime-task")).durable?.conversationId, beforeHistory.durable?.conversationId, "resource changes keep the native conversation");
  assert.equal(agent.listRuntimeContextSnapshots("runtime-task")[0]?.assemblyHash, snapshots[0]?.assemblyHash);
  assert(!agent.listRuntimeContextSnapshots("runtime-task")[0]?.resolvedInstructions.some(segment => segment.content.includes("resource revision two")));
  projects.update({ id: project.id, instructions: "Changed after execution" });
  assert(snapshots[0]?.resolvedInstructions.some(segment => segment.content.includes(project.instructions!)), "prior audit is immutable");
  const notice = patches.find(patch => patch.type === "capability_notices");
  assert(notice?.type === "capability_notices");
  assert.deepEqual(notice.notices.map(item => [item.kind, item.reason]), [["expert", "project_policy_denied"], ["connector", "project_policy_denied"], ["mcp", "project_policy_denied"]]);
  assert(!notice.notices.some(item => item.id === "background-denied"));
  for (const name of ["project_plan_list", "project_plan_get", "project_plan_create", "project_plan_update", "memory_search", "memory_get", "memory_create", "memory_update", "memory_history"]) {
    assert(requests[0]!.tools.includes(name), "main declared tools include " + name);
  }
  db.upsertTask({ id: "no-project-task", title: "No project", updatedAt: 1, welcomeMode: "coding" });
  await fixture.prompt({ taskId: "no-project-task", text: "run", userMessageId: "no-project-user", assistantMessageId: "no-project-answer" });
  assert(!requests.at(-1)!.instructions.includes(project.instructions!));
  assert(!requests.at(-1)!.tools.includes("project_plan_list"));
  assert(requests.at(-1)!.tools.includes("memory_search"));
  await agent.releaseDurableTask("no-project-task"); db.deleteTask("no-project-task");
  assert.throws(() => agent.listRuntimeContextSnapshots("no-project-task"), /任务不存在/, "deleted tasks cannot be inspected");
  assert.equal((db.connection.prepare("SELECT COUNT(*) AS n FROM task_runtime_context_snapshots WHERE task_id = ?").get("no-project-task") as { n: number }).n, 0, "task purge cascades audit rows");
  db.upsertTask({ id: "global-gate-task", title: "Unavailable capabilities", updatedAt: 1, welcomeMode: "coding", expertId: "missing-expert" });
  agent.setTaskConnectorIds("global-gate-task", ["missing-connector"]);
  const unavailable = agent.inspectRuntimeContext("global-gate-task");
  assert.equal(unavailable.capabilities.find(item => item.kind === "expert")?.reason, "global_disabled");
  assert.equal(unavailable.capabilities.find(item => item.kind === "connector")?.reason, "global_disabled");
  await fixture.prompt({ taskId: "global-gate-task", text: "run", userMessageId: "global-user", assistantMessageId: "global-answer", expertId: "missing-expert", connectorIds: ["missing-connector"] });
  projects.createResource({ projectId: project.id, kind: "text", title: "Shared context", value: "Auxiliary project resource" });
  projects.createTodo({ projectId: project.id, title: "Read-only plan item", status: "doing" });
  projects.createMemory({ projectId: project.id, kind: "decision", title: "Shared decision", content: "Auxiliary project memory" });
  await agent.startBtw({ btwId: "btw-plan-test", parentTaskId: "runtime-task" });
  await agent.btwPrompt({ btwId: "btw-plan-test", userMessageId: "btw-turn-1", assistantMessageId: "btw-answer-1", text: "summarize" });
  const btw = requests.at(-1)!;
  assert.deepEqual([...btw.tools].sort(), ["read", "grep", "find", "ls", "project_plan_list", "project_plan_get", "memory_search", "memory_get", "memory_history"].sort());
  assert(btw.instructions.includes("只读"));
  assert(!btw.instructions.includes("project_plan_create"));
  const calls = requests.length;
  await agent.btwClose("btw-plan-test");
  await agent.startBtw({ btwId: "btw-plan-test", parentTaskId: "runtime-task" });
  await agent.btwPrompt({ btwId: "btw-plan-test", userMessageId: "btw-turn-1", assistantMessageId: "btw-answer-1", text: "changed retry" });
  assert.equal(requests.length, calls, "reopened BTW recovers the exact receipt without model replay");
  await agent.btwClose("btw-plan-test");
  db.upsertTask({ id: "runtime-task", title: "Runtime", updatedAt: Date.now(), projectId: null });
  await agent.startBtw({ btwId: "btw-unbound-test", parentTaskId: "runtime-task" });
  await agent.btwPrompt({ btwId: "btw-unbound-test", userMessageId: "btw-unbound-user", assistantMessageId: "btw-unbound-answer", text: "summarize" });
  const unbound = requests.at(-1)!;
  assert(!unbound.tools.some(name => name.startsWith("project_plan_")));
  assert(unbound.tools.includes("memory_search"), "task/global Memory remains scoped and read-only after project unbind");
  assert(!unbound.tools.some(name => ["write", "edit", "bash", "memory_create", "memory_update"].includes(name)));
  assert(unbound.instructions.includes("当前任务工作目录"));
  await agent.btwClose("btw-unbound-test");
  console.log("PASS native project policy, immutable runtime audit, tool declarations and persistent read-only BTW");
} finally {
  unsubscribe(); await fixture.close(); db.close(); rmSync(root, { recursive: true, force: true });
}
