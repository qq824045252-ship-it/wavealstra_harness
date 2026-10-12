/**
 * 桌面验收夹具：向隔离 profile 的 app.db 写入两个任务。
 *  - DOT_DONE_UNREAD：已结束、从未查看 → 期望绿点（点击后消失并持久化）
 *  - DOT_RUNNING：进行中 → 期望蓝点（同时保证启动时不会有任务被自动当作当前任务而误清绿点）
 * 用法：node out/tests/task-status-dot-seed.cjs <app.db 绝对路径>
 */
import { AppDatabase } from "../src/main/db/AppDatabase";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: task-status-dot-seed.cjs <app.db>");

const db = new AppDatabase(dbPath);
const now = Date.now();
db.upsertTask({
  id: "dot-done-unread",
  title: "DOT_DONE_UNREAD",
  status: "completed",
  updatedAt: now - 60_000,
});
db.upsertTask({
  id: "dot-running",
  title: "DOT_RUNNING",
  status: "in_progress",
  updatedAt: now - 5_000,
});
db.close();

console.log(JSON.stringify({ dbPath, seeded: ["dot-done-unread", "dot-running"] }));
