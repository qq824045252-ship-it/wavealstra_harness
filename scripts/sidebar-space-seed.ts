/**
 * 桌面验收种子：写入 2 个空间 + 各自 1 个任务（用于侧栏空间树展开/收起断言）。
 * 用法：node out/tests/sidebar-space-seed.cjs <app.db 绝对路径>
 */
import { AppDatabase } from "../src/main/db/AppDatabase";

const dbPath = process.argv[2];
if (!dbPath) throw new Error("usage: sidebar-space-seed.cjs <app.db>");

const db = new AppDatabase(dbPath);
const now = Date.now();
for (const [index, name] of ["SPACE_ALPHA", "SPACE_BETA"].entries()) {
  db.upsertSpace({ id: `sp-${name.toLowerCase()}`, name, parentId: null, sortOrder: (index + 1) * 1000, path: undefined });
  db.upsertTask({
    id: `task-${name.toLowerCase()}`,
    title: `${name}_TASK`,
    spaceId: `sp-${name.toLowerCase()}`,
    status: "completed",
    updatedAt: now - index * 1000,
  });
}
db.close();
console.log(JSON.stringify({ dbPath, spaces: 2, tasks: 2 }));
