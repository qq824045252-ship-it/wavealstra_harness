import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { SkillsService } from "../src/main/skills/SkillsService";

async function main(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-memory-skill-"));
  process.env.USERPROFILE = sandbox;
  process.env.HOME = sandbox;
  const db = new AppDatabase(":memory:");
  try {
    assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 27);
    assert.equal(db.schemaVersion, 27);

    const ws = db.createSpace({ id: "ws-learn", name: "Learn" });
    db.connection.prepare(
      `INSERT INTO projects (id,name,description,instructions,created_at,updated_at,archived,resource_budget_chars)
       VALUES ('proj-learn','Learn Project',NULL,NULL,?,?,0,128000)`,
    ).run(Date.now(), Date.now());
    db.upsertTask({
      id: "task-learn-1",
      title: "task-learn-1",
      spaceId: ws.id,
      projectId: "proj-learn",
      status: "completed",
      updatedAt: Date.now(),
    });
    db.upsertTask({
      id: "task-learn-2",
      title: "task-learn-2",
      spaceId: ws.id,
      projectId: "proj-learn",
      status: "in_progress",
      updatedAt: Date.now(),
    });

    const memory = new MemoryService(db, { semantic: false });
    const skills = new SkillsService();

    memory.create({
      kind: "fact",
      title: "普通事实",
      content: "事实不会变成 Skill。",
      scopeType: "global",
      sourceType: "user",
      explicit: true,
      confidence: 1,
    });
    assert.equal(memory.listSkillCandidates().length, 0, "non-procedure memory must never create Skill Candidate");

    memory.create({
      kind: "procedure",
      title: "临时任务流程",
      content: "只在当前任务里做一次的步骤，不应自动扩散到可复用技能。",
      scopeType: "task",
      scopeId: "task-learn-1",
      sourceTaskId: "task-learn-1",
      sourceType: "agent",
      confidence: 0.95,
      importance: 2,
    });
    assert.equal(memory.listSkillCandidates().length, 0, "task-only procedure must stay out of reusable Skill learning");

    const projectProcedure = memory.create({
      kind: "procedure",
      title: "Focused Review Workflow",
      content: "先限定变更范围，再做独立 review；只运行相关 focused tests，最后检查 git diff --check 和工作树。",
      scopeType: "project",
      scopeId: "proj-learn",
      sourceTaskId: "task-learn-1",
      sourceType: "agent",
      confidence: 0.9,
      importance: 2,
      evidence: [{ evidenceKind: "task", refId: "task-learn-1" }],
    });
    assert.equal(memory.listSkillCandidates().length, 0, "procedures require explicit candidate evaluation");
    memory.refreshSkillCandidates();
    let candidate = memory.listSkillCandidates().find((item) => item.sourceMemoryIds.includes(projectProcedure.id));
    assert.ok(candidate);
    assert.equal(candidate!.status, "draft", "one-task project procedure starts as draft");
    assert.equal(candidate!.distinctTaskCount, 1);

    const pipeline = new MemoryPipelineManager(db);
    const turn2 = pipeline.capture({
      taskId: "task-learn-2",
      userMessageId: "u-2",
      assistantMessageId: "a-2",
      userText: "按 Focused Review Workflow 再执行一次。",
      assistantText: "已按相同流程完成并验证。",
    }).turn;
    memory.repository.addEvidence({
      id: "ev-task2",
      memoryId: projectProcedure.id,
      evidenceKind: "conversation",
      refId: turn2.id,
      refTitle: "second task support",
      createdAt: Date.now(),
    });
    let refreshed = memory.refreshSkillCandidates();
    assert.ok(refreshed.evaluated >= 1);
    candidate = memory.listSkillCandidates().find((item) => item.sourceMemoryIds.includes(projectProcedure.id));
    assert.ok(candidate);
    assert.equal(candidate!.distinctTaskCount, 2);
    assert.equal(candidate!.completedTaskCount, 1, "in-progress supporting task is provenance but not a successful support");
    assert.equal(candidate!.status, "draft", "in-progress second task must not promote procedure to ready");

    db.upsertTask({
      id: "task-learn-2",
      title: "task-learn-2",
      spaceId: ws.id,
      projectId: "proj-learn",
      status: "completed",
      updatedAt: Date.now(),
    });
    refreshed = memory.refreshSkillCandidates();
    candidate = memory.listSkillCandidates().find((item) => item.sourceMemoryIds.includes(projectProcedure.id));
    assert.equal(candidate!.status, "ready", "same procedure supported by a second completed task becomes ready");
    assert.equal(candidate!.completedTaskCount, 2, "only completed supporting tasks count toward automatic readiness");

    const promotedProcedure = memory.create({
      kind: "procedure",
      title: "Promotable Procedure",
      content: "先在项目里验证一套可复用流程，再明确提升到跨项目通用范围。",
      scopeType: "project",
      scopeId: "proj-learn",
      sourceTaskId: "task-learn-1",
      sourceType: "agent",
      confidence: 0.9,
      importance: 2,
    });
    memory.refreshSkillCandidates();
    const projectCandidateBeforePromotion = memory.listSkillCandidates().find((item) => item.sourceMemoryIds.includes(promotedProcedure.id));
    assert.equal(projectCandidateBeforePromotion?.scopeType, "project");
    const promotedMemory = memory.promote(promotedProcedure.id, "global");
    assert.ok(promotedMemory.scopes.some((scope) => scope.scopeType === "global"));
    assert.equal(memory.learning.get(projectCandidateBeforePromotion!.id)?.status, "stale", "promotion changes reusable scope and stales old Project candidate");
    memory.refreshSkillCandidates();
    const lineageAfterPromotion = memory.listSkillCandidates().filter((item) => item.sourceMemoryIds.includes(promotedProcedure.id));
    assert.ok(lineageAfterPromotion.some((item) => item.scopeType === "global" && (item.status === "draft" || item.status === "ready")), "promotion creates a new Global candidate for review");

    db.deleteTask("task-learn-2");
    refreshed = memory.refreshSkillCandidates();
    candidate = memory.learning.get(candidate!.id);
    assert.equal(candidate?.completedTaskCount, 1, "purging a supporting task removes it from successful support count");
    assert.equal(candidate?.status, "draft", "ready candidate falls back to draft when repeated-success evidence is purged");

    db.upsertTask({
      id: "task-learn-3",
      title: "task-learn-3",
      spaceId: ws.id,
      projectId: "proj-learn",
      status: "completed",
      updatedAt: Date.now(),
    });
    const turn3 = pipeline.capture({
      taskId: "task-learn-3",
      userMessageId: "u-3",
      assistantMessageId: "a-3",
      userText: "在新的已完成任务中再次采用 Focused Review Workflow。",
      assistantText: "已再次按相同流程完成并验证。",
    }).turn;
    memory.repository.addEvidence({
      id: "ev-task3",
      memoryId: projectProcedure.id,
      evidenceKind: "conversation",
      refId: turn3.id,
      refTitle: "replacement completed task support",
      createdAt: Date.now(),
    });
    memory.refreshSkillCandidates();
    candidate = memory.learning.get(candidate!.id);
    assert.equal(candidate?.completedTaskCount, 2);
    assert.equal(candidate?.status, "ready", "new completed-task support can promote the same unchanged procedure back to ready");

    const globalProcedure = memory.create({
      kind: "procedure",
      title: "Explicit Global Procedure",
      content: "用户明确要求长期使用这个通用流程：先确认范围，再执行，再做短验证。",
      scopeType: "global",
      sourceType: "user",
      explicit: true,
      confidence: 1,
      importance: 2,
    });
    memory.refreshSkillCandidates();
    const globalCandidate = memory.listSkillCandidates().find((item) => item.sourceMemoryIds.includes(globalProcedure.id));
    assert.equal(globalCandidate?.status, "ready", "explicit global procedure can be ready without fake repetition");

    const approved = candidate!;
    assert.equal(memory.learning.isCandidateGrounded(approved), true);
    const installed = skills.installLearnedSkill({
      candidateId: approved.id,
      slug: approved.slug,
      title: approved.title,
      description: approved.description,
      instructions: approved.instructions,
      sourceMemoryIds: approved.sourceMemoryIds,
      scopeType: approved.scopeType,
      scopeId: approved.scopeId,
    });
    const materialized = memory.learning.markMaterialized(approved.id, installed.id);
    assert.equal(materialized.status, "materialized");
    assert.equal(memory.learning.isInstalledSkillRunnable(installed.id, approved.sourceMemoryIds), true, "grounded materialized Skill is runtime-eligible");
    const skillDir = join(sandbox, ".mybuddy", "skills", approved.slug);
    const skillPath = join(skillDir, "SKILL.md");
    assert.ok(existsSync(skillPath), "approval materializes a real SKILL.md through SkillsService");
    const originalSkill = readFileSync(skillPath, "utf-8");
    assert.match(originalSkill, /disable-model-invocation:\s*true/);
    assert.ok(originalSkill.includes("Focused Review Workflow"));
    const discovered = skills.listInstalled().find((item) => item.name === approved.slug);
    assert.equal(discovered?.enabled, false, "learned Skill is installed disabled by default");
    assert.equal(
      (await import("node:fs")).readdirSync(join(sandbox, ".mybuddy", "skills")).some((name) => name.includes(".learned-") && (name.endsWith(".tmp") || name.endsWith(".bak"))),
      false,
      "successful learned Skill materialization leaves no swap temp/backup directories",
    );

    // Existing non-learned Skill with the same slug must never be overwritten.
    const collisionSlug = globalCandidate!.slug;
    const collisionDir = join(sandbox, ".mybuddy", "skills", collisionSlug);
    mkdirSync(collisionDir, { recursive: true });
    writeFileSync(join(collisionDir, "SKILL.md"), `---\nname: ${collisionSlug}\ndescription: user owned\n---\n# user skill\n`, "utf-8");
    assert.throws(() => skills.installLearnedSkill({
      candidateId: globalCandidate!.id,
      slug: collisionSlug,
      title: globalCandidate!.title,
      description: globalCandidate!.description,
      instructions: globalCandidate!.instructions,
      sourceMemoryIds: globalCandidate!.sourceMemoryIds,
      scopeType: globalCandidate!.scopeType,
      scopeId: globalCandidate!.scopeId,
    }), /不是 Memory 学习技能|拒绝覆盖/);
    rmSync(collisionDir, { recursive: true, force: true });

    // Meaningful L1 content change creates a new candidate revision; installed Skill remains byte-for-byte unchanged.
    const updatedMemory = memory.update({
      id: projectProcedure.id,
      content: "先限定变更范围，再做独立 review；验证只跑相关 focused tests；结束前必须检查 git diff --check、工作树和迁移边界。",
      changedBy: "user",
      changeReason: "procedure refined",
    });
    assert.equal(updatedMemory.kind, "procedure");
    const oldAfterUpdate = memory.learning.get(approved.id);
    assert.equal(oldAfterUpdate?.status, "stale", "old approved candidate becomes stale after source procedure changes");
    assert.equal(memory.learning.isInstalledSkillRunnable(installed.id, approved.sourceMemoryIds), false, "stale source governance excludes the old learned Skill from runtime");
    assert.equal(readFileSync(skillPath, "utf-8"), originalSkill, "background learning must never rewrite an installed Skill");
    memory.refreshSkillCandidates();
    const newCandidate = memory.listSkillCandidates().find((item) =>
      item.sourceMemoryIds.includes(projectProcedure.id) && item.id !== approved.id && (item.status === "draft" || item.status === "ready"),
    );
    assert.ok(newCandidate, "changed procedure produces a new reviewable candidate revision");

    const updatedInstalled = skills.installLearnedSkill({
      candidateId: newCandidate!.id,
      slug: newCandidate!.slug,
      title: newCandidate!.title,
      description: newCandidate!.description,
      instructions: newCandidate!.instructions,
      sourceMemoryIds: newCandidate!.sourceMemoryIds,
      scopeType: newCandidate!.scopeType,
      scopeId: newCandidate!.scopeId,
    });
    memory.learning.markMaterialized(newCandidate!.id, updatedInstalled.id);
    assert.equal(memory.learning.isInstalledSkillRunnable(updatedInstalled.id, newCandidate!.sourceMemoryIds), true, "newly approved grounded revision re-enters runtime eligibility");
    const revisedSkill = readFileSync(skillPath, "utf-8");
    assert.notEqual(revisedSkill, originalSkill, "explicit approval of the new revision may update the learned Skill lineage");
    assert.ok(revisedSkill.includes("迁移边界"));

    memory.forget(projectProcedure.id);
    assert.equal(memory.learning.get(newCandidate!.id)?.status, "stale", "forget invalidates the latest learned candidate");
    assert.equal(memory.learning.isInstalledSkillRunnable(updatedInstalled.id, newCandidate!.sourceMemoryIds), false, "forgotten Procedure prevents the materialized Skill from running");
    assert.ok(existsSync(skillPath), "forget does not silently uninstall or rewrite the already materialized Skill");

    const rejectCandidate = memory.listSkillCandidates().find((item) => item.id === globalCandidate!.id);
    assert.ok(rejectCandidate);
    const rejected = memory.learning.reject(rejectCandidate!.id);
    assert.equal(rejected.status, "rejected");

    const stats = memory.stats();
    assert.ok(stats.skillCandidates >= 0);
    assert.ok(stats.readySkillCandidates >= 0);

    console.log("memory-skill-learning-test: PASS");
  } finally {
    db.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("memory-skill-learning-test: FAILED", error);
  process.exit(1);
});
