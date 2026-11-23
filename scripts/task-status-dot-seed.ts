/**
 * 桌面验收夹具：向隔离 profile 的 app.db 写入三个任务。
 *  - DOT_DONE_UNREAD：在侧栏确认的结果。
 *  - DOT_BOARD_UNREAD：看板发现的新产物，晚于任务上次确认时间。
 *  - DOT_RUNNING：进行中任务显示动画。
 * 用法：node out/tests/task-status-dot-seed.cjs <app.db 绝对路径>
 */
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { TaskBoardRepository } from "../src/main/task/TaskBoardRepository";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: task-status-dot-seed.cjs <app.db>");

const db = new AppDatabase(dbPath);
new ArtifactRepository(db.connection);
new BotConversationRepository(db.connection);
const board = new TaskBoardRepository(db.connection);
const now = Date.now();
db.upsertTask({
  id: "dot-board-unread",
  title: "DOT_BOARD_UNREAD",
  status: "completed",
  updatedAt: now - 70_000,
  doneAckedAt: now - 60_000,
});
board.note("dot-board-unread", "result", "新产物", now - 30_000);
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

console.log(JSON.stringify({ dbPath, seeded: ["dot-done-unread", "dot-board-unread", "dot-running"] }));
