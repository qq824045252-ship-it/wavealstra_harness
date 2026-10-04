import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-skill-effectiveness-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

const { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/main/db/AppDatabase");
const { SkillsService } = await import("../src/main/skills/SkillsService");
const { MemorySkillEffectivenessService } = await import("../src/main/memory/MemorySkillEffectivenessService");
const { filterSkillsForMode } = await import("../src/main/agent/SkillPolicy");

async function main(): Promise<void> {
  const db = new AppDatabase(":memory:");
  try {
    assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 27);
    assert.equal(db.schemaVersion, 27);
    db.upsertTask({ id: "eff-task", title: "Effectiveness Task", status: "in_progress", updatedAt: Date.now() });

    const skills = new SkillsService();
    const installed = skills.installLearnedSkill({
      candidateId: "candidate-v1",
      slug: "learned-effectiveness-test",
      title: "Effectiveness Test",
      description: "learned skill effectiveness test",
      instructions: "# Effectiveness Test\n\nFollow the learned procedure.",
      sourceMemoryIds: ["mem-procedure-1"],
      scopeType: "global",
    });
    assert.equal(installed.enabled, false, "learned Skill starts disabled");
    const skillPath = installed.filePath!;
    assert.ok(existsSync(skillPath));

    const disabledDto = skills.listInstalled().find((item) => item.id === installed.id)!;
    assert.equal(disabledDto.source, "memory-learned");
    const disabledFilter = filterSkillsForMode(
      [{ id: disabledDto.id, name: disabledDto.name, description: disabledDto.description, enabled: disabledDto.enabled }],
      "working",
      { prefer: [], demote: [], hide: [], allow: [] },
    );
    assert.equal(disabledFilter.visible.length, 0, "disabled learned Skill must not enter final allowed set / exposure");

    const enabled = skills.setEnabled(installed.id, true);
    assert.equal(enabled.enabled, true);
    const skillBytesBeforeFeedback = readFileSync(skillPath);
    const enabledDto = skills.listInstalled().find((item) => item.id === installed.id)!;
    const enabledFilter = filterSkillsForMode(
      [{ id: enabledDto.id, name: enabledDto.name, description: enabledDto.description, enabled: enabledDto.enabled }],
      "working",
      { prefer: [], demote: [], hide: [], allow: [] },
    );
    assert.deepEqual(enabledFilter.visible.map((item) => item.name), [installed.id], "enabled learned Skill enters final allowed set");

    const meta = skills.getLearnedSkillMetadata(installed.id);
    assert.ok(meta);
    assert.equal(meta!.candidateId, "candidate-v1");
    assert.deepEqual(meta!.sourceMemoryIds, ["mem-procedure-1"]);
    assert.equal(skills.resolveLearnedSkillRead(skillPath, process.cwd())?.skillId, installed.id, "real learned SKILL.md read resolves provenance");

    const userSkillDir = join(sandbox, ".mybuddy", "skills", "user-owned");
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(join(userSkillDir, "SKILL.md"), "---\nname: user-owned\ndescription: user\n---\n# User\n");
    assert.equal(skills.resolveLearnedSkillRead(join(userSkillDir, "SKILL.md"), process.cwd()), undefined, "ordinary user Skill read is not mislabeled learned telemetry");

    const eff = new MemorySkillEffectivenessService(db);
    const learnedRef = { skillId: meta!.skillId, candidateId: meta!.candidateId, sourceMemoryIds: meta!.sourceMemoryIds };
    eff.recordExposure({ taskId: "eff-task", assistantMessageId: "a1", skills: [learnedRef], at: 100 });
    let row = eff.getByTurnSkill("eff-task", "a1", installed.id)!;
    assert.ok(row);
    assert.equal(row.invokedAt, undefined, "exposure alone must not count invocation");
    assert.equal(row.outcome, "pending");

    eff.markInvoked({ taskId: "eff-task", assistantMessageId: "a1", skill: learnedRef, kind: "read", toolCallId: "read-1", at: 120 });
    eff.markInvoked({ taskId: "eff-task", assistantMessageId: "a1", skill: learnedRef, kind: "read", toolCallId: "read-2", at: 130 });
    row = eff.getByTurnSkill("eff-task", "a1", installed.id)!;
    assert.equal(row.invokedAt, 120, "same turn repeated reads are idempotent and keep first invocation time");
    assert.equal(row.toolCallId, "read-1");
    eff.markTurnOutcome("eff-task", "a1", "completed", 150);
    row = eff.get(row.id)!;
    assert.equal(row.outcome, "completed");

    eff.recordExposure({ taskId: "eff-task", assistantMessageId: "a2", skills: [learnedRef], at: 200 });
    eff.markInvoked({ taskId: "eff-task", assistantMessageId: "a2", skill: learnedRef, kind: "command", at: 201 });
    eff.markTurnOutcome("eff-task", "a2", "failed", 230);

    eff.recordExposure({ taskId: "eff-task", assistantMessageId: "a3", skills: [learnedRef], at: 300 });
    eff.markInvoked({ taskId: "eff-task", assistantMessageId: "a3", skill: learnedRef, kind: "read", toolCallId: "read-3", at: 310 });
    eff.abortPendingForTask("eff-task", 330);

    eff.recordExposure({ taskId: "eff-task", assistantMessageId: "a4", skills: [learnedRef], at: 400 });
    const summaries = eff.summaries();
    const summary = summaries.find((item) => item.skillId === installed.id)!;
    assert.equal(summary.exposures, 4);
    assert.equal(summary.invocations, 3, "exposure and invocation counts stay distinct");
    assert.equal(summary.completedInvocations, 1);
    assert.equal(summary.failedInvocations, 1);
    assert.equal(summary.abortedInvocations, 1);
    assert.equal(summary.adoptionRate, 0.75);
    assert.equal(summary.completionRate, 1 / 3);

    const invoked = eff.listRecent(10, true);
    assert.equal(invoked.length, 3, "recent invoked list excludes exposure-only rows");
    const feedbackTarget = invoked.find((item) => item.assistantMessageId === "a1")!;
    const negative = eff.setFeedback(feedbackTarget.id, "needs_revision");
    assert.equal(negative.feedbackKind, "needs_revision");
    assert.deepEqual(readFileSync(skillPath), skillBytesBeforeFeedback, "negative feedback must not rewrite learned Skill bytes");
    const afterFeedback = eff.summaries().find((item) => item.skillId === installed.id)!;
    assert.equal(afterFeedback.needsRevisionFeedback, 1);
    assert.equal(afterFeedback.correctionRate, 1);

    const cleared = eff.setFeedback(feedbackTarget.id, null);
    assert.equal(cleared.feedbackKind, undefined);
    assert.deepEqual(readFileSync(skillPath), skillBytesBeforeFeedback, "clearing feedback also leaves Skill unchanged");

    const learnedRefV2 = { skillId: meta!.skillId, candidateId: "candidate-v2", sourceMemoryIds: meta!.sourceMemoryIds };
    eff.recordExposure({ taskId: "eff-task", assistantMessageId: "a-v2", skills: [learnedRefV2], at: 500 });
    eff.markInvoked({ taskId: "eff-task", assistantMessageId: "a-v2", skill: learnedRefV2, kind: "command", at: 501 });
    eff.markTurnOutcome("eff-task", "a-v2", "completed", 520);
    const versioned = eff.summaries().filter((item) => item.skillId === installed.id);
    assert.equal(versioned.length, 2, "same learned Skill lineage is summarized separately per Candidate revision");
    assert.equal(versioned.find((item) => item.candidateId === "candidate-v1")?.exposures, 4, "v1 metrics stay isolated");
    assert.equal(versioned.find((item) => item.candidateId === "candidate-v2")?.exposures, 1, "v2 starts with clean metrics");

    assert.throws(() => {
      const exposureOnly = eff.getByTurnSkill("eff-task", "a4", installed.id)!;
      eff.setFeedback(exposureOnly.id, "incorrect");
    }, /实际调用过/);

    db.upsertTask({ id: "fk-task", title: "FK Task", status: "completed", updatedAt: Date.now() });
    eff.recordExposure({ taskId: "fk-task", assistantMessageId: "fk-a1", skills: [learnedRef], at: 600 });
    assert.equal((db.connection.prepare("SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE task_id='fk-task'").get() as { n: number }).n, 1);
    db.connection.prepare("DELETE FROM tasks WHERE id='fk-task'").run();
    assert.equal((db.connection.prepare("SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE task_id='fk-task'").get() as { n: number }).n, 0, "task FK cascades telemetry even on direct task deletion");

    assert.ok(db.connection.prepare("SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE task_id='eff-task'").get());
    db.deleteTask("eff-task");
    const countAfterPurge = Number((db.connection.prepare("SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE task_id='eff-task'").get() as { n: number }).n);
    assert.equal(countAfterPurge, 0, "hard task purge removes effectiveness telemetry for that task");

    console.log("memory-skill-effectiveness-test: PASS");
  } finally {
    db.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("memory-skill-effectiveness-test: FAILED", error);
  process.exit(1);
});
