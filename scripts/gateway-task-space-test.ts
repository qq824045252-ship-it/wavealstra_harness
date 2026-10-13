import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import {
  GATEWAY_ROOT_SPACE_ID,
  GATEWAY_ROOT_SPACE_NAME,
  ensureGatewayChannelSpace,
  gatewayChannelSpaceId,
} from "../src/main/gateway/gateway-task-space";
import { gatewayBotTaskId } from "../src/shared/gateway-task";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle } from "../src/main/task/TaskExecutionWorkspaceLifecycle";

async function main(): Promise<void> {
const root = mkdtempSync(join(tmpdir(), "mybuddy-gateway-space-"));
const db = new AppDatabase(join(root, "app.db"));
try {
  db.createSpace({ id: "user-root", name: GATEWAY_ROOT_SPACE_NAME });
  const feishu = ensureGatewayChannelSpace(db, "feishu-default", "飞书");
  const gatewayRoot = db.getSpace(GATEWAY_ROOT_SPACE_ID)!;
  assert.equal(gatewayRoot.name, `${GATEWAY_ROOT_SPACE_NAME} 2`);
  assert.equal(gatewayRoot.parentId, null);
  assert.equal(gatewayRoot.path, undefined);
  assert.equal(feishu, gatewayChannelSpaceId("feishu-default"));
  const feishuSpace = db.getSpace(feishu)!;
  assert.equal(feishuSpace.name, "飞书");
  assert.equal(feishuSpace.parentId, GATEWAY_ROOT_SPACE_ID);
  assert.equal(feishuSpace.path, undefined);
  assert.equal(db.getSpace("user-root")?.name, GATEWAY_ROOT_SPACE_NAME);

  db.renameSpace(GATEWAY_ROOT_SPACE_ID, "公司入口");
  db.renameSpace(feishu, "公司飞书");
  db.createSpace({ id: "other", name: "别的" });
  db.moveSpace({ spaceId: feishu, targetParentId: "other" });
  ensureGatewayChannelSpace(db, "feishu-default", "飞书");
  assert.equal(db.getSpace(GATEWAY_ROOT_SPACE_ID)?.name, "公司入口");
  assert.equal(db.getSpace(feishu)?.name, "公司飞书");
  assert.equal(db.getSpace(feishu)?.parentId, "other");
  assert.equal(db.getSpace(feishu)?.path, undefined);

  db.createSpace({ id: "user-wecom", name: "企微", parentId: GATEWAY_ROOT_SPACE_ID });
  const before = db.listSpaces().length;
  const wecom = ensureGatewayChannelSpace(db, "wecom-default", "企微");
  assert.equal(db.getSpace(wecom)?.name, "企微 2");
  assert.equal(db.getSpace(wecom)?.parentId, GATEWAY_ROOT_SPACE_ID);
  assert.equal(db.getSpace(wecom)?.path, undefined);
  assert.equal(db.getSpace("user-wecom")?.name, "企微");
  ensureGatewayChannelSpace(db, "wecom-default", "企微");
  assert.equal(db.listSpaces().length, before + 1);
  console.log("PASS gateway folders keep stable ids, avoid name takeover, and do not gain a disk path");
  await assertDeletedGatewayChatRestoresItsWorkspace(root, db);
} finally {
  db.close();
}
console.log("GATEWAY_TASK_SPACE_TESTS_PASSED", root);
}

async function assertDeletedGatewayChatRestoresItsWorkspace(root: string, db: AppDatabase): Promise<void> {
  const workspace = new TaskExecutionWorkspace(join(root, "task-workspaces"));
  const lifecycle = new TaskExecutionWorkspaceLifecycle({ db, workspace, trashRoot: join(root, "task-workspaces-trash") });
  const taskId = gatewayBotTaskId("gw-telegram-default-5664468624");
  db.upsertTask({ id: taskId, title: "你好。", welcomeMode: "bot", modePresetId: "native", updatedAt: 1 });
  const cwd = workspace.ensureTaskExecutionWorkspace(taskId);
  writeFileSync(join(cwd, "proof.txt"), "kept");
  db.connection.exec(`CREATE TABLE IF NOT EXISTS durable_bot_bindings (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    backend TEXT NOT NULL CHECK(backend = 'pi-durable'), directory TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL)`);
  db.connection.prepare("INSERT INTO durable_bot_bindings(task_id, backend, directory, cwd) VALUES (?, 'pi-durable', ?, ?)").run(taskId, join(root, "durable-dir"), cwd);
  await lifecycle.trash(taskId);
  assert.equal(existsSync(cwd), false);
  assert.equal(db.getTask(taskId)?.archived, true);
  if (db.getTaskExecutionWorkspaceState(taskId)?.state === "trashed") lifecycle.restore(taskId);
  const binding = db.connection.prepare("SELECT cwd FROM durable_bot_bindings WHERE task_id = ?").get(taskId) as { cwd: string };
  assert.equal(binding.cwd, cwd);
  assert.equal(existsSync(binding.cwd), true);
  assert.equal(readFileSync(join(binding.cwd, "proof.txt"), "utf8"), "kept");
  assert.equal(db.getTaskExecutionWorkspaceState(taskId)?.state, "active");
  assert.equal(db.getTask(taskId)?.archived, false);
  console.log("PASS a deleted gateway chat restores its bot workspace");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
