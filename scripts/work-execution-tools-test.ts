import assert from "node:assert/strict";
import { workExecutionToolAllowed } from "../src/main/agent/work/WorkExecutionToolPolicy";
import { ToolGate } from "../src/main/agent/durable/ToolGate";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "work-execution-tools-"));
const database = new AppDatabase(join(directory, "app.db"));
try {
  const bots = new BotRegistry(database.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(database.connection, { bots });
  const taskId = "fixture-executor";
  database.upsertTask({ id: taskId, title: "Executor", cwd: directory, updatedAt: Date.now() });
  const gate = new ToolGate(() => taskId, (id, name) => workExecutionToolAllowed(name, () => works.repo.bindingForTask(id)));
  const lifecycleTools = ["conversation_goal_create", "conversation_goal_update", "conversation_goal_propose_complete"];
  for (const tool of lifecycleTools) assert.equal(gate.allowed(tool), true, "ordinary Task keeps its interactive goal tools");
  const actor = { kind: "user" as const, userId: LOCAL_USER_ID, entry: "desktop" as const, grants: DESKTOP_USER_GRANTS };
  const created = works.createWork(actor, { operationId: "create", title: "Delegated work", ownerBotId: DEFAULT_BOT_ID,
    workspacePath: directory, inputSnapshotId: "input" });
  assert(created.ok);
  const work = created.work;
  const dispatched = works.dispatchExecution(actor, { operationId: "dispatch", workId: work.workId, taskId,
    botId: DEFAULT_BOT_ID, durableStoreKey: "fixture", conversationId: "fixture-conversation", workspaceBinding: directory,
    versionGuard: { expectedStateVersion: work.stateVersion,
      expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } });
  assert(dispatched.ok);
  await Promise.resolve(); // Binding is installed after runtime preparation, across a real async phase.
  for (const tool of lifecycleTools) assert.equal(gate.allowed(tool), false,
    `delegated Work must not expose the ordinary interactive lifecycle tool ${tool}`);
  for (const tool of ["conversation_goal_get", "request_user_input", "read", "write", "register_artifact", "subagent"])
    assert.equal(gate.allowed(tool), true, `existing execution capability remains available: ${tool}`);
  console.log("PASS Work executor lifecycle ownership after late binding; ordinary Task goal tools and execution capabilities preserved");
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
