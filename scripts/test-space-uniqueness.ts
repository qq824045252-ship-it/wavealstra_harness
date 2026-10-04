/**
 * 空间唯一性修复的行为测试（临时库，不碰真实数据）
 * 运行方式：
 *   node_modules/.bin/esbuild scripts/test-space-uniqueness.ts --bundle --platform=node \
 *     --format=cjs --outfile=out/tests/space-uniqueness.cjs --external:better-sqlite3
 *   node out/tests/space-uniqueness.cjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";

const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-space-test-"));
const dbPath = join(tempRoot, "test.db");
const db = new AppDatabase(dbPath);

function expectConstraint(fn: () => unknown, label: string): void {
  try {
    fn();
    assert.fail(`${label}: 应当抛 SQLITE_CONSTRAINT 但没有`);
  } catch (err) {
    assert.ok(
      String(err).includes("UNIQUE") || String(err).includes("constraint"),
      `${label}: 异常信息不是唯一约束: ${String(err)}`,
    );
    console.log(`✔ ${label} → 正确拦截（${String(err).slice(0, 60)}…）`);
  }
}

try {
  // 1) 正常创建
  db.upsertSpace({ id: "s1", name: "docs", path: "C:/a/docs" });
  db.upsertSpace({ id: "s2", name: "周报系统", path: undefined });
  console.log("✔ 正常创建空间");

  // 2) 唯一索引兜底：同名插入（忽略大小写）必须被拦截
  expectConstraint(() => db.upsertSpace({ id: "s3", name: "DOCS", path: "D:/b/docs" }), "同名(大小写不同)插入");
  expectConstraint(() => db.upsertSpace({ id: "s4", name: "docs", path: "C:/a/docs" }), "完全同名插入");

  // 3) 重命名撞名必须被拦截
  expectConstraint(() => db.renameSpace("s2", "Docs"), "重命名撞名(大小写)");

  // 4) 重命名到可用名称成功
  db.renameSpace("s2", "周报系统v2");
  assert.equal(db.listSpaces().find((s) => s.id === "s2")?.name, "周报系统v2");
  console.log("✔ 重命名到可用名称成功");

  // 5) 任务占位解析：cwd 与已有空间 path 相同 → 复用该空间 id
  db.upsertTask({
    id: "t1",
    title: "t",
    spaceId: "ghost-a",
    cwd: "C:/a/docs",
    updatedAt: Date.now(),
  });
  assert.equal(
    db.listTasks().find((t) => t.id === "t1")?.spaceId,
    "s1",
    "cwd 命中已有空间 path 时应复用 s1",
  );
  console.log("✔ 占位解析：cwd 命中已有 path → 复用");

  // 6) 占位解析：cwd 的 basename 与「无 path 的同名空间」一致 → 复用
  db.upsertSpace({ id: "s5", name: "legacy", path: undefined });
  db.upsertTask({
    id: "t2",
    title: "t",
    spaceId: "ghost-b",
    cwd: "C:/x/legacy",
    updatedAt: Date.now(),
  });
  assert.equal(
    db.listTasks().find((t) => t.id === "t2")?.spaceId,
    "s5",
    "basename 命中无 path 同名空间时应复用 s5",
  );
  console.log("✔ 占位解析：basename 命中无 path 同名空间 → 复用");

  // 7) 占位解析：basename 撞名但路径不同 → 不绑错，占位空间名自动加后缀
  db.upsertTask({
    id: "t3",
    title: "t",
    spaceId: "ghost-c",
    cwd: "D:/other/docs",
    updatedAt: Date.now(),
  });
  const t3 = db.listTasks().find((t) => t.id === "t3")!;
  assert.notEqual(t3.spaceId, "s1", "不同路径同名不应绑到 s1");
  const created = db.listSpaces().find((s) => s.id === t3.spaceId)!;
  assert.equal(t3.spaceId, "ghost-c", "应绑定新建的占位空间（其 id 沿用请求 id）");
  assert.notEqual(created.name.toLowerCase(), "docs", "占位名不得与现有空间重名");
  assert.ok(created.name.startsWith("docs"), `占位名应带 docs 前缀，实际: ${created.name}`);
  console.log(`✔ 占位解析：同名不同路径 → 新建后缀空间「${created.name}」`);

  // 8) 占位解析：无 cwd、id 撞名已有空间名 → 复用
  db.upsertTask({ id: "t4", title: "t", spaceId: "docs", updatedAt: Date.now() });
  assert.equal(
    db.listTasks().find((t) => t.id === "t4")?.spaceId,
    "s1",
    "无 cwd 且 id 撞名时应复用 s1",
  );
  console.log("✔ 占位解析：无 cwd 且 id 撞名 → 复用");

  // 9) 空间总数校验：全程没有产生重复名称
  const names = db.listSpaces().map((s) => s.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, "不得存在同名空间");
  console.log(`✔ 全程无同名空间（共 ${names.length} 个）`);

  console.log("\n全部测试通过 ✅");
} finally {
  db.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
