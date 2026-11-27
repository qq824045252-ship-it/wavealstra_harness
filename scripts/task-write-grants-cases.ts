import assert from "node:assert/strict";
import { join } from "node:path";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { RuntimeAuditReader } from "../src/main/platform/runtime-audit";

export async function verifyTaskWriteGrants(application: AppDatabase, background: RuntimeAuditReader, root: string) {
  const at = Date.now();
  const taskId = "write-grant-task";
  const otherTaskId = "write-grant-other-task";
  const path = join(root, "historical-write-grant");
  await application.writeTaskRecord({ id: taskId, title: "Grant history", updatedAt: at });
  await application.writeTaskRecord({ id: otherTaskId, title: "Unrelated task", updatedAt: at });

  assert.deepEqual(await background.batch2Write({ kind: "addTaskWriteGrant", taskId, path, at }), { ok: true });
  const expected = [{ taskId, path, createdAt: at }];
  assert.deepEqual(await application.readTaskWriteGrants(taskId), expected);
  assert.deepEqual(await application.readTaskWriteGrants(otherTaskId), []);

  await application.archiveTaskAsync(taskId, true);
  assert.deepEqual(await application.readTaskWriteGrants(taskId), expected);
  assert.equal(await application.deleteTaskWriteGrantAsync(taskId, path), true);
  assert.deepEqual(await background.readTaskWriteGrants(taskId), []);
  assert.equal(await application.deleteTaskWriteGrantAsync(taskId, path), false);
  console.log("PASS Core lists historical write grants only for their task and another client observes revocation");
}
