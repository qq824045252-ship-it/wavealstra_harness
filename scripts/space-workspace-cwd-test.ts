/**
 * Space.path 作为任务可写工作区（短测）
 * 运行：esbuild + node（见下方 package 或手动）
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";

function resolveCwd(db: AppDatabase, ws: TaskExecutionWorkspace, taskId: string): string {
  const task = db.getTask(taskId);
  const spaceId = task?.spaceId;
  if (spaceId) {
    const space = db.getSpace(spaceId);
    const raw = space?.path?.trim();
    if (raw) {
      const abs = resolve(raw);
      mkdirSync(abs, { recursive: true });
      db.bindTaskExecutionWorkspaceCwd(taskId, abs);
      return abs;
    }
  }
  const cwd = ws.ensureTaskExecutionWorkspace(taskId);
  db.bindTaskExecutionWorkspaceCwd(taskId, cwd);
  return cwd;
}

const root = mkdtempSync(join(tmpdir(), "space-cwd-"));
const projects = join(root, "task-workspaces");
const free = join(root, "free_project");
mkdirSync(free, { recursive: true });
writeFileSync(join(free, "项目管理.md"), "x");
const db = new AppDatabase(join(root, "app.db"));
const ws = new TaskExecutionWorkspace(projects);

db.upsertSpace({ id: "sp1", name: "free_project", path: free });
db.upsertTask({ id: "t-space", title: "工况", updatedAt: Date.now(), spaceId: "sp1" });
db.upsertTask({ id: "t-alone", title: "闲聊", updatedAt: Date.now() });

const a = resolveCwd(db, ws, "t-space");
const b = resolveCwd(db, ws, "t-alone");
assert.equal(a, free, "有 Space.path 应写 free_project");
assert.ok(b.startsWith(projects), "无 Space 应走隔离 task-workspaces");
assert.equal(db.getTask("t-space")!.cwd, free);
console.log("PASS  space-bound cwd + isolated fallback");
db.close();
rmSync(root, { recursive: true, force: true });
