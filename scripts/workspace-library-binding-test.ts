/**
 * WorkspaceLibraryBindingService + migration — R1 Scope Completion（真实 AppDatabase 路径）
 *
 * 覆盖（主文档 §19.1）：
 * - migration 创建 workspace_library_links + 双向索引
 * - migration rerun safe（幂等重开）
 * - duplicate binding idempotent / unbind idempotent
 * - resolveLibrarySpaceIds：workspace scope → library space id（映射，非求交）
 * - workspace delete cleanup / library space delete cleanup（无 orphan）
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`);} else { failed++; console.error(`  ✗ ${msg}`);} }
function eq<T>(a: T, b: T, msg: string) { try { assert.deepStrictEqual(a,b); passed++; console.log(`  ✓ ${msg}`);} catch(e){ failed++; console.error(`  ✗ ${msg}\n    expected ${JSON.stringify(b)}\n    actual ${JSON.stringify(a)}`);} }

function hasTable(db: AppDatabase, name: string): boolean {
  return db.connection.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
}
function hasIndex(db: AppDatabase, name: string): boolean {
  return db.connection.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name) !== undefined;
}

async function main() {
  console.log("== §19.1 migration + binding service（真实 AppDatabase） ==");
  const dir = mkdtempSync(join(tmpdir(), "ws-binding-"));
  let libRootId = "";
  let libOtherId = "";
  try {
    const path = join(dir, "app.db");
    {
      const db = new AppDatabase(path);
      ok(db.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, `schemaVersion=${CURRENT_DATABASE_SCHEMA_VERSION}`);
      ok(hasTable(db, "workspace_library_links"), "workspace_library_links 表存在");
      ok(hasIndex(db, "idx_workspace_library_links_workspace"), "workspace 索引存在");
      ok(hasIndex(db, "idx_workspace_library_links_library"), "library 索引存在");

      const binding = new WorkspaceLibraryBindingService(db);
      const lib = new LibraryService(db);

      // workspace spaces
      db.createSpace({ id: "root", name: "Root", parentId: null });
      db.createSpace({ id: "water", name: "Water", parentId: "root" });

      // library spaces（真实 LibraryService.createSpace）
      const libRoot = lib.createSpace({ name: "lib-root" } as any);
      const libWater = lib.createSpace({ name: "lib-water" } as any);
      const libOther = lib.createSpace({ name: "lib-other" } as any);
      const publicFolder = lib.createCollection({ spaceId: libRoot.id, parentId: null, name: "公共知识" } as any);
      libRootId = libRoot.id;
      libOtherId = libOther.id;

      // collection binding：文件夹可独立绑定，重复 bind 幂等
      binding.bindCollection("root", libRoot.id, publicFolder.id);
      binding.bindCollection("root", libRoot.id, publicFolder.id);
      eq(
        binding.listCollectionsByWorkspace("root"),
        [{ librarySpaceId: libRoot.id, collectionId: publicFolder.id }],
        "collection duplicate bind idempotent（单条）",
      );
      ok(
        binding.resolveTargets(["root"]).collections.some((x) => x.collectionId === publicFolder.id),
        "resolveTargets 包含 collection binding",
      );

      // bind idempotent
      binding.bind("root", libRoot.id);
      binding.bind("root", libRoot.id);
      eq(binding.listByWorkspace("root"), [libRoot.id], "duplicate bind idempotent（单条）");
      binding.bind("water", libWater.id);
      binding.bind("water", libOther.id);

      // listByWorkspace / listByLibrarySpace
      eq(binding.listByLibrarySpace(libRoot.id), ["root"], "listByLibrarySpace 反向查询");

      // resolveLibrarySpaceIds：scope=[root,water] → {libRoot,libWater,libOther}（映射 + 去重）
      eq(
        binding.resolveLibrarySpaceIds(["root", "water"]).sort(),
        [libRoot.id, libWater.id, libOther.id].sort(),
        "resolveLibrarySpaceIds 映射 scope → library ids",
      );
      eq(binding.resolveLibrarySpaceIds(["root", "root"]), [libRoot.id], "resolveLibrarySpaceIds 去重");
      eq(binding.resolveLibrarySpaceIds([]), [], "空 scope 空结果");

      // unbind idempotent
      binding.unbind("water", libOther.id);
      binding.unbind("water", libOther.id);
      eq(binding.listByWorkspace("water"), [libWater.id], "unbind idempotent");

      // collection delete cleanup
      lib.deleteCollection(publicFolder.id);
      eq(binding.listCollectionsByWorkspace("root"), [], "library collection delete 清理对应 binding");

      // workspace delete cleanup（空叶子空间）
      binding.bind("root", libOther.id);
      const waterFolder = lib.createCollection({ spaceId: libWater.id, parentId: null, name: "water-folder" } as any);
      binding.bindCollection("water", libWater.id, waterFolder.id);
      db.deleteSpace("water"); // water 无子/任务，可删
      eq(binding.listByLibrarySpace(libWater.id), [], "workspace delete 清理对应 space binding");
      eq(binding.listByCollection(waterFolder.id), [], "workspace delete 清理对应 collection binding");

      // library space delete cleanup
      binding.bind("root", libWater.id);
      lib.deleteSpace(libWater.id);
      eq(binding.listByLibrarySpace(libWater.id), [], "library space delete 清理对应 binding");
      eq(
        binding.listByWorkspace("root").sort(),
        [libRoot.id, libOther.id].sort(),
        "删除后 root 剩余 binding 正确",
      );
      db.close();
    }

    // rerun safe：幂等重开不报错、表仍在、binding 持久化
    {
      const db = new AppDatabase(path);
      ok(db.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, "重开幂等：schemaVersion 不变");
      ok(hasTable(db, "workspace_library_links"), "重开后表仍在");
      const binding = new WorkspaceLibraryBindingService(db);
      eq(
        binding.listByWorkspace("root").sort(),
        [libRootId, libOtherId].sort(),
        "重开后 root 的绑定持久化（lib-water 已删、lib-root/lib-other 保留）",
      );
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
