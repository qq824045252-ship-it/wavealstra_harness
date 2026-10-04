import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function buildV13(path: string) {
  const db = new AppDatabase(path);
  db.close();
}

async function testDedupeOrphan() {
  console.log("== P1-1 dedupe child conflict orphan ==");
  const dir = mkdtempSync(join(tmpdir(), "p1-1-"));
  const dbPath = join(dir, "dedupe.db");
  try {
    buildV13(dbPath);
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = OFF");
    raw.exec("DROP INDEX IF EXISTS uq_spaces_root_name");
    raw.exec("DROP INDEX IF EXISTS uq_spaces_child_name");
    raw.exec("DROP INDEX IF EXISTS idx_spaces_parent");
    const now = Date.now();
    // Two root spaces with same name (NOCASE) "DupRoot" – winner will be with path, loser without
    raw.prepare("INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)").run("root-winner", "DupRoot", "/tmp/winner", null, 1000, now, now);
    raw.prepare("INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)").run("root-loser", "duproot", null, null, 2000, now-1000, now-1000);
    // winner has child "ConflictChild"
    raw.prepare("INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)").run("child-winner", "ConflictChild", null, "root-winner", 1000, now, now);
    // loser has child with same name -> conflict when moving loser child to winner
    raw.prepare("INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)").run("child-loser", "conflictchild", null, "root-loser", 1000, now, now);
    // loser also has a task to verify it stays if loser retained
    raw.prepare("INSERT INTO tasks (id, title, space_id, updated_at) VALUES (?,?,?,?)").run("t-loser", "loser task", "root-loser", now);
    raw.close();

    // build dedupe script if not already
    const dedupeCjs = join(process.cwd(), "out/tests/dedupe-check.cjs");
    const res = spawnSync("node", [dedupeCjs, dbPath, "--apply"], { encoding: "utf8" });
    console.log(res.stdout?.slice(0, 2000));
    if (res.stderr) console.error(res.stderr.slice(0, 2000));
    const check = new Database(dbPath);
    const loserExists = check.prepare("SELECT 1 FROM spaces WHERE id = ?").get("root-loser") !== undefined;
    const winnerExists = check.prepare("SELECT 1 FROM spaces WHERE id = ?").get("root-winner") !== undefined;
    const orphanRows = check.prepare("SELECT id, parent_id FROM spaces WHERE parent_id = 'root-loser'").all() as any[];
    const childLoserParent = check.prepare("SELECT parent_id FROM spaces WHERE id = ?").get("child-loser") as any;
    const winnerChildren = check.prepare("SELECT id, name FROM spaces WHERE parent_id = 'root-winner'").all() as any[];
    const loserChildrenAfter = check.prepare("SELECT id FROM spaces WHERE parent_id = 'root-loser'").all() as any[];
    const taskSpace = check.prepare("SELECT space_id FROM tasks WHERE id = ?").get("t-loser") as any;
    check.close();
    // Expect: loser retained (since conflict), no orphan (no space parent_id points to deleted id), child-loser still under loser
    assert(winnerExists, "winner still exists");
    assert(loserExists, "loser retained due to conflict (no orphan)");
    assert(orphanRows.length === loserChildrenAfter.length, "orphan check: no space points to deleted loser beyond retained children");
    // Specifically child-loser should still be under loser, not orphaned to deleted parent
    assert(childLoserParent?.parent_id === "root-loser", "conflicting child still under loser, not orphaned");
    assert(winnerChildren.some((c:any)=>c.id==="child-winner"), "winner's original child still there");
    assert(!winnerChildren.some((c:any)=>c.id==="child-loser"), "loser child not moved to winner on conflict");
    // Task should still be under loser (since merge skipped)
    assert(taskSpace?.space_id === "root-loser", "loser task still under loser (merge skipped)");
    // Ensure no space has parent_id that doesn't exist
    const allSpaces = new Database(dbPath).prepare("SELECT id, parent_id FROM spaces").all() as any[];
    let hasOrphan = false;
    const ids = new Set(allSpaces.map((r:any)=>r.id));
    for (const r of allSpaces) {
      if (r.parent_id && !ids.has(r.parent_id)) { hasOrphan = true; console.error(` orphan found ${r.id} -> ${r.parent_id}`); }
    }
    assert(!hasOrphan, "no orphan parent_id after dedupe");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log("== P1-1 dedupe no-conflict still merges ==");
  const dir2 = mkdtempSync(join(tmpdir(), "p1-1b-"));
  const dbPath2 = join(dir2, "dedupe2.db");
  try {
    buildV13(dbPath2);
    const raw = new Database(dbPath2);
    raw.pragma("foreign_keys = OFF");
    raw.exec("DROP INDEX IF EXISTS uq_spaces_root_name");
    raw.exec("DROP INDEX IF EXISTS uq_spaces_child_name");
    raw.exec("DROP INDEX IF EXISTS idx_spaces_parent");
    const now = Date.now();
    raw.prepare("INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)").run("r-win", "SameRoot", "/p", null, 1000, now, now);
    raw.prepare("INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)").run("r-lose", "sameroot", null, null, 2000, now-100, now-100);
    raw.prepare("INSERT INTO spaces (id, name, path, parent_id, sort_order, created_at, updated_at, archived) VALUES (?,?,?,?,?,?,?,0)").run("c-lose", "UniqueChild", null, "r-lose", 1000, now, now);
    raw.close();
    const dedupeCjs = join(process.cwd(), "out/tests/dedupe-check.cjs");
    spawnSync("node", [dedupeCjs, dbPath2, "--apply"], { encoding: "utf8" });
    const check = new Database(dbPath2);
    const loserGone = check.prepare("SELECT 1 FROM spaces WHERE id = ?").get("r-lose") === undefined;
    const childParent = check.prepare("SELECT parent_id FROM spaces WHERE id = ?").get("c-lose") as any;
    check.close();
    assert(loserGone, "loser without conflict correctly deleted");
    assert(childParent?.parent_id === "r-win", "unique child moved to winner when no conflict");
  } finally { try { rmSync(dir2, { recursive: true, force: true }); } catch {} }
}

function testP15SortCollision() {
  console.log("== P1-5 targetSortOrder collision + old parent renumber ==");
  const dir = mkdtempSync(join(tmpdir(), "p15-"));
  try {
    const path = join(dir, "sort.db");
    const db = new AppDatabase(path);
    const root = db.createSpace({ id: "root", name: "Root" });
    const a = db.createSpace({ id: "a", name: "A", parentId: "root" });
    const b = db.createSpace({ id: "b", name: "B", parentId: "root" });
    const c = db.createSpace({ id: "c", name: "C", parentId: "root" });
    const ordersBefore = db.getSpaceChildren("root").map(s=> ({id:s.id, order:s.sortOrder}));
    console.log(" before", ordersBefore);
    // Force duplicate: b already has some order, set c to b's order via explicit targetSortOrder
    const bOrder = db.getSpace("b")!.sortOrder!;
    db.moveSpace({ spaceId: "c", targetParentId: "root", targetSortOrder: bOrder });
    const after = db.getSpaceChildren("root").map(s=> ({id:s.id, order:s.sortOrder}));
    console.log(" after targetSortOrder duplicate", after);
    const dupCount = new Set(after.map(x=>x.order)).size !== after.length;
    assert(!dupCount, "explicit targetSortOrder duplicate auto-renumbered, no collision");
    assert(after.every(x=> x.order! %1000===0 && x.order! >0), "after renumber all 1000 step");
    // old parent renumber: move a to new root2, check old parent (root) compacted
    const root2 = db.createSpace({ id: "root2", name: "Root2" });
    // before move, root children orders are spaced; after moving a away, root should be compacted
    db.moveSpace({ spaceId: "a", targetParentId: "root2" });
    const rootChildrenAfter = db.getSpaceChildren("root");
    const root2Children = db.getSpaceChildren("root2");
    assert(rootChildrenAfter.length === 2, "old parent now 2 children after moving a out");
    assert(rootChildrenAfter.every(s=> s.sortOrder! %1000===0), "old parent renumbered 1000 step");
    assert(root2Children.some(s=> s.id==="a"), "a moved to root2");
    // task sort collision
    db.upsertTask({ id:"t1", title:"t1", updatedAt:1, spaceId:"root"});
    db.upsertTask({ id:"t2", title:"t2", updatedAt:2, spaceId:"root"});
    const t1 = db.getTask("t1")!;
    const t2 = db.getTask("t2")!;
    // Move t1 with explicit duplicate sort
    // first get t2 order
    const t2Order = t2.spaceSortOrder!;
    db.moveTaskInWorkspaceTree({ taskId:"t1", targetSpaceId:"root", targetSortOrder: t2Order });
    const tasksAfter = db.connection.prepare("SELECT id, space_sort_order FROM tasks WHERE space_id='root' ORDER BY space_sort_order").all() as any[];
    const taskDup = new Set(tasksAfter.map((r:any)=>r.space_sort_order)).size !== tasksAfter.length;
    assert(!taskDup, "task explicit sortOrder duplicate renumbered");
    db.close();
  } finally { try { rmSync(dir, { recursive:true, force:true}); } catch {} }
}

function testP14Rename() {
  console.log("== P1-4 parent-scoped rename ==");
  const dir = mkdtempSync(join(tmpdir(), "p14-"));
  try {
    const path = join(dir, "rename.db");
    const db = new AppDatabase(path);
    db.createSpace({ id:"root", name:"Root"});
    db.createSpace({ id:"root2", name:"Root2"});
    db.createSpace({ id:"childA", name:"Alpha", parentId:"root"});
    db.createSpace({ id:"childB", name:"Beta", parentId:"root"});
    db.createSpace({ id:"childC", name:"Alpha", parentId:"root2"}); // same name different parent allowed
    // rename childB to Alpha should fail (same parent conflict)
    let threw=false;
    try { db.renameSpace("childB", "Alpha"); } catch { threw=true; }
    assert(threw, "same parent rename to existing name rejected");
    // rename childC to Beta should succeed (different parent, Beta only exists under root, not root2)
    threw=false;
    try { db.renameSpace("childC", "Beta"); } catch (e) { threw=true; console.error(e); }
    assert(!threw, "cross-parent same name rename allowed");
    assert(db.getSpace("childC")?.name==="Beta", "cross-parent rename succeeded");
    // case-insensitive
    threw=false;
    try { db.renameSpace("childB", "alpha"); } catch { threw=true; }
    assert(threw, "case-insensitive same parent rejected");
    db.close();
  } finally { try{ rmSync(dir,{recursive:true,force:true});}catch{}}
}

function testP12Effective() {
  console.log("== P1-2 effectiveArchived ==");
  const dir = mkdtempSync(join(tmpdir(), "p12-"));
  try {
    const path = join(dir, "archive.db");
    const db = new AppDatabase(path);
    db.createSpace({id:"root", name:"Root"});
    db.createSpace({id:"child", name:"Child", parentId:"root"});
    db.createSpace({id:"grand", name:"Grand", parentId:"child"});
    db.upsertTask({id:"t1", title:"t1", updatedAt:1, spaceId:"child"});
    db.upsertTask({id:"t2", title:"t2", updatedAt:2, spaceId:"grand"});
    db.archiveSpace("root", true);
    assert(db.isSpaceEffectiveArchived("child")===true, "child effective after parent archive");
    assert(db.isSpaceEffectiveArchived("grand")===true, "grand effective after parent archive");
    assert(db.isTaskEffectiveArchived("t1")===true, "task under child effective");
    assert(db.isTaskEffectiveArchived("t2")===true, "task under grand effective");
    // restore parent, child explicitly archived should stay
    db.archiveSpace("child", true);
    db.archiveSpace("root", false);
    assert(db.isSpaceEffectiveArchived("child")===true, "child still effective after parent restore (explicit)");
    assert(db.isSpaceEffectiveArchived("grand")===true, "grand still effective via child");
    // getSpace DTO effective
    const childDto = db.getSpace("child");
    const grandDto = db.getSpace("grand");
    assert(childDto?.effectiveArchived===true, "getSpace child effectiveArchived DTO");
    assert(grandDto?.effectiveArchived===true, "getSpace grand effectiveArchived DTO");
    // listSpaces DTO
    const listed = db.listSpaces();
    assert(listed.find(s=>s.id==="grand")?.effectiveArchived===true, "listSpaces grand effective");
    // Task effective via DTO? listTasks doesn't have effective, but isTaskEffectiveArchived covers
    db.close();
  } finally { try{rmSync(dir,{recursive:true,force:true});}catch{} }
}

function testP13Delete() {
  console.log("== P1-3 deleteSpace error propagation ==");
  const dir = mkdtempSync(join(tmpdir(), "p13-"));
  try {
    const path = join(dir, "del.db");
    const db = new AppDatabase(path);
    db.createSpace({id:"root", name:"Root"});
    db.createSpace({id:"child", name:"Child", parentId:"root"});
    db.upsertTask({id:"t", title:"t", updatedAt:1, spaceId:"root"});
    let errMsg="";
    try { db.deleteSpace("root"); } catch(e){ errMsg= String(e); }
    assert(errMsg.includes("尚有"), "deleteSpace non-empty throws with correct message");
    // ensure DB IPC would map to workspace_not_empty – we test AppDatabase directly
    // empty leaf should succeed
    db.moveTaskInWorkspaceTree({taskId:"t", targetSpaceId:null});
    db.deleteSpace("child");
    assert(db.getSpace("child")===undefined, "empty leaf delete succeeds");
    db.close();
  } finally { try{rmSync(dir,{recursive:true,force:true});}catch{}}
}

async function main(){
  await testDedupeOrphan();
  testP15SortCollision();
  testP14Rename();
  testP12Effective();
  testP13Delete();
  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed>0?1:0);
}
void main();
