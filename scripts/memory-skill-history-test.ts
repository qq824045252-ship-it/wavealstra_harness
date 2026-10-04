import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemorySkillRevisionService } from "../src/main/memory/MemorySkillRevisionService";
import { SkillsService } from "../src/main/skills/SkillsService";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-skill-history-"));
process.env.USERPROFILE = sandbox;
const db = new AppDatabase(":memory:");
try {
  const memory = new MemoryService(db, { semantic: false });
  const revisions = new MemorySkillRevisionService(db);
  const skills = new SkillsService();
  for (const title of ["待完善", "待批准", "已生成", "历史 A", "历史 B", "保留历史"]) {
    memory.create({ kind: "procedure", title, content: "先核对输入单位，再完成计算，最后验证并记录结果。", scopeType: "global", sourceType: "manual", explicit: true, confidence: 1 });
  }
  memory.refreshSkillCandidates();
  const candidates = memory.listSkillCandidates();
  const byTitle = (title: string) => candidates.find((item) => item.title === title)!;
  const generated = byTitle("已生成");
  const installed = skills.installLearnedSkill({ candidateId: generated.id, slug: generated.slug, title: generated.title, description: generated.description, instructions: generated.instructions, sourceMemoryIds: generated.sourceMemoryIds, scopeType: generated.scopeType });
  memory.learning.markMaterialized(generated.id, installed.id);
  const skillContent = readFileSync(installed.filePath!, "utf8");
  const setStatus = db.connection.prepare("UPDATE memory_skill_candidates SET status=? WHERE id=?");
  for (const [title, status] of [["待完善", "draft"], ["待批准", "ready"], ["历史 A", "stale"], ["历史 B", "rejected"], ["保留历史", "stale"]]) setStatus.run(status, byTitle(title).id);
  const selected = [byTitle("历史 A").id, byTitle("历史 B").id];
  assert.throws(() => memory.deleteSkillHistory({ kind: "candidate", ids: [selected[0], generated.id] }), /只能删除/);
  assert.ok(memory.learning.get(selected[0]), "protected record rejects the entire mixed selection");
  db.connection.exec(`CREATE TRIGGER fail_history_delete BEFORE DELETE ON memory_skill_candidates WHEN OLD.status='rejected' BEGIN SELECT RAISE(ABORT, 'history rollback test'); END`);
  assert.throws(() => memory.deleteSkillHistory({ kind: "candidate", ids: selected }), /history rollback test/);
  assert.ok(selected.every((id) => memory.learning.get(id)), "transaction failure restores all selected rows");
  db.connection.exec("DROP TRIGGER fail_history_delete");
  assert.equal(memory.deleteSkillHistory({ kind: "candidate", ids: [...selected, selected[0]] }), 2);
  assert.equal(memory.deleteSkillHistory({ kind: "candidate", ids: selected }), 0, "repeated deletion is harmless");
  assert.ok(memory.learning.get(byTitle("保留历史").id));
  assert.ok(memory.learning.isInstalledSkillRunnable(installed.id, generated.sourceMemoryIds));
  assert.equal(readFileSync(installed.filePath!, "utf8"), skillContent);
  const insert = db.connection.prepare("INSERT INTO memory_skill_candidates (id,slug,title,description,instructions,status,scope_type,source_signature,created_at,updated_at) VALUES (?,?,'历史批量','','','stale','global','',1,1)");
  db.connection.transaction(() => { for (let i = 0; i < 1005; i++) insert.run(`bulk-${i}`, `bulk-${i}`); })();
  assert.equal(memory.listSkillCandidates(undefined, 1000).length, 1000);
  assert.equal(memory.deleteSkillHistory({ kind: "candidate", all: true }), 1006, "all history deletion is not limited by UI pagination");
  assert.deepEqual(memory.listSkillCandidates().map((item) => item.status).sort(), ["draft", "materialized", "ready"]);
  assert.equal(memory.stats().total, 6, "source memories remain");
  assert.ok(memory.learning.isInstalledSkillRunnable(installed.id, generated.sourceMemoryIds));
  assert.equal(readFileSync(installed.filePath!, "utf8"), skillContent);
  // Clearing a rejection is a history cleanup, not a permanent suppression rule.
  memory.refreshSkillCandidates();
  assert.ok(memory.learning.get(selected[1]));

  const insertRevision = db.connection.prepare(`INSERT INTO memory_skill_revision_candidates
    (id,skill_id,base_version,base_content_hash,title,status,issue_summary,base_description,base_instructions,proposed_description,proposed_instructions,feedback_signature,created_at,updated_at)
    VALUES (?,'retained-skill','1.0.0',?, ?,?,'','','','','',?,1,1)`);
  for (const status of ["draft", "ready", "materialized", "stale", "rejected"]) insertRevision.run(status, status, status, status, status);
  assert.throws(() => memory.deleteSkillHistory({ kind: "revision", ids: ["stale", "ready"] }), /只能删除/);
  assert.ok(revisions.get("stale"));
  assert.equal(memory.deleteSkillHistory({ kind: "revision", ids: ["stale"] }), 1);
  assert.ok(revisions.get("rejected"), "unselected revision history remains");
  for (let i = 0; i < 110; i++) insertRevision.run(`revision-${i}`, `hash-${i}`, "历史修订", "stale", `feedback-${i}`);
  assert.equal(memory.deleteSkillHistory({ kind: "revision", all: true }), 111);
  assert.deepEqual(revisions.list().map((item) => item.status).sort(), ["draft", "materialized", "ready"]);
  for (const request of [{ kind: "other", all: true }, { kind: "candidate", all: "true" }, { kind: "candidate", all: true, ids: selected }, { kind: "candidate", ids: "id" }, { kind: "candidate", ids: [""] }, { kind: "candidate" }]) {
    assert.throws(() => memory.deleteSkillHistory(request as never), /请选择/);
  }
  console.log("memory-skill-history-test: PASS (exact selection, protected pending/installed records, rollback, uncapped cleanup, source/file/runtime retention and revision scope)");
} finally {
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
}
