/**
 * Skill Revision Candidate focused contract.
 *
 * Verifies: explicit negative feedback is the only trigger, note-less feedback stays draft,
 * human approval produces an atomic versioned learned Skill, old effectiveness remains versioned,
 * and manual Skill edits stale an already-generated revision instead of being overwritten.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mybuddy-skill-revision-"));
process.env.USERPROFILE = root;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy"), { recursive: true });

const { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/main/db/AppDatabase");
const { SkillsService } = await import("../src/main/skills/SkillsService");
const { MemorySkillEffectivenessService } = await import("../src/main/memory/MemorySkillEffectivenessService");
const { AgentService } = await import("../src/main/agent/AgentService");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");

async function main(): Promise<void> {
  const db = new AppDatabase(join(root, "app.db"));
  try {
    assert.equal(CURRENT_DATABASE_SCHEMA_VERSION, 27);
    assert.equal(db.schemaVersion, 27);
    db.upsertTask({ id: "rev-task", title: "Revision Task", updatedAt: Date.now(), welcomeMode: "coding" });

    const skills = new SkillsService();
    const baseCandidateId = "mskill_base_v1";
    const sourceMemoryIds = ["mem-procedure-1"];
    const installed = skills.installLearnedSkill({
      candidateId: baseCandidateId,
      slug: "learned-revise-demo",
      title: "Revision Demo",
      description: "Run the stable demo procedure.",
      instructions: "# Revision Demo\n\n## Procedure\n1. Read input.\n2. Produce output.",
      sourceMemoryIds,
      scopeType: "global",
    });
    assert.equal(installed.enabled, false, "new learned Skill starts disabled");
    const baseSource = skills.getLearnedSkillRevisionSource(installed.id);
    assert.ok(baseSource);
    assert.equal(baseSource!.version, "1.0.0");
    assert.equal(baseSource!.candidateId, baseCandidateId);

    const effectiveness = new MemorySkillEffectivenessService(db);
    const ref = { skillId: installed.id, candidateId: baseCandidateId, sourceMemoryIds };
    const invocation = effectiveness.markInvoked({
      taskId: "rev-task",
      assistantMessageId: "a-v1",
      skill: ref,
      kind: "command",
    });
    effectiveness.markTurnOutcome("rev-task", "a-v1", "failed");

    const agent = new AgentService(db, new TaskExecutionWorkspace(join(root, "task-workspaces")));

    // [1] Runtime failure is only corroborating evidence and cannot independently create a revision.
    let refresh = agent.refreshKernelSkillRevisionCandidates();
    assert.equal(refresh.evaluated, 1);
    assert.equal(agent.kernelSkillRevisionCandidates(undefined, 20).length, 0, "failed outcome alone must not create Revision Candidate");

    // [2] Explicit negative feedback without concrete note is reviewable but cannot be approved.
    effectiveness.setFeedback(invocation.id, "needs_revision");
    refresh = agent.refreshKernelSkillRevisionCandidates();
    assert.equal(refresh.created, 1);
    let revisions = agent.kernelSkillRevisionCandidates(undefined, 20);
    const draft = revisions.find((item) => item.skillId === installed.id && item.baseCandidateId === baseCandidateId && item.status === "draft");
    assert.ok(draft, "note-less negative feedback creates draft revision");
    assert.equal(draft!.failedInvocationCount, 1, "failed invocation is retained as corroborating evidence");
    assert.equal(draft!.proposedInstructions, draft!.baseInstructions, "without a concrete note the draft must not invent changes");
    assert.throws(() => agent.approveKernelSkillRevisionCandidate(draft!.id), /不可批准/);

    // [3] A concrete correction creates a ready candidate and preserves the full v1 snapshot.
    effectiveness.setFeedback(invocation.id, "needs_revision", "输出前必须校验输入单位，单位不一致时先转换，不能直接计算。");
    refresh = agent.refreshKernelSkillRevisionCandidates();
    revisions = agent.kernelSkillRevisionCandidates(undefined, 20);
    const ready = revisions.find((item) => item.skillId === installed.id && item.baseCandidateId === baseCandidateId && item.status === "ready");
    assert.ok(ready, "explicit feedback note promotes a new revision candidate to ready");
    assert.equal(ready!.baseInstructions, baseSource!.instructions, "candidate stores immutable base Skill snapshot");
    assert.match(ready!.proposedInstructions, /单位不一致时先转换/);
    assert.ok(revisions.some((item) => item.id === draft!.id && item.status === "stale"), "older draft is staled when feedback signature changes");
    const stableReadyId = ready!.id;
    effectiveness.setFeedback(invocation.id, "needs_revision", "输出前必须校验输入单位，单位不一致时先转换，不能直接计算。");
    const sameFeedbackRefresh = agent.refreshKernelSkillRevisionCandidates();
    const sameReady = agent.kernelSkillRevisionCandidates(undefined, 20).find((item) => item.id === stableReadyId);
    assert.equal(sameFeedbackRefresh.created, 0, "re-saving identical negative feedback must not churn Revision Candidate ids");
    assert.equal(sameReady?.status, "ready", "same evidence content keeps the same ready candidate");

    // [4] Human approval atomically installs v1.0.1 and leaves the replacement disabled.
    const approved = agent.approveKernelSkillRevisionCandidate(ready!.id);
    assert.equal(approved.candidate.status, "materialized");
    assert.equal(approved.candidate.materializedVersion, "1.0.1");
    const v2 = skills.getLearnedSkillRevisionSource(installed.id);
    assert.ok(v2);
    assert.equal(v2!.candidateId, ready!.id, "new telemetry lineage points at the concrete revision candidate");
    assert.equal(v2!.version, "1.0.1");
    assert.match(v2!.instructions, /单位不一致时先转换/);
    assert.equal(skills.listInstalled().find((item) => item.id === installed.id)?.enabled, false, "approved revision stays disabled until explicit Skill Center enablement");

    // [5] v1 effectiveness remains attached to v1; revisions do not rewrite historical telemetry.
    const summaries = effectiveness.summaries(20);
    const v1Summary = summaries.find((item) => item.skillId === installed.id && item.candidateId === baseCandidateId);
    assert.equal(v1Summary?.invocations, 1);
    assert.equal(v1Summary?.needsRevisionFeedback, 1);
    assert.equal(summaries.some((item) => item.skillId === installed.id && item.candidateId === ready!.id), false, "v2 has no telemetry until actually exposed/invoked");

    // [6] Generate v2->v3 candidate, then manually edit SKILL.md. Approval must stale instead of overwrite.
    const v2Invocation = effectiveness.markInvoked({
      taskId: "rev-task",
      assistantMessageId: "a-v2",
      skill: { skillId: installed.id, candidateId: ready!.id, sourceMemoryIds },
      kind: "read",
      toolCallId: "read-v2",
    });
    effectiveness.markTurnOutcome("rev-task", "a-v2", "completed");
    agent.setKernelSkillFeedback(v2Invocation.id, "incorrect", "遇到未知单位时必须停止并向用户确认，不允许猜测。");
    const v3Ready = agent.kernelSkillRevisionCandidates(undefined, 20).find(
      (item) => item.skillId === installed.id && item.baseCandidateId === ready!.id && item.status === "ready",
    );
    assert.ok(v3Ready, "v2 negative feedback generates a version-isolated v3 candidate");

    const skillPath = skills.getLearnedSkillMetadata(installed.id)!.filePath;
    writeFileSync(skillPath, `${readFileSync(skillPath, "utf-8")}\n\n## Manual operator edit\nDo not overwrite me.\n`, "utf-8");
    assert.throws(
      () => agent.approveKernelSkillRevisionCandidate(v3Ready!.id),
      /已发生变化/,
      "manual Skill edits after candidate generation must block approval",
    );
    assert.equal(agent.kernelSkillRevisionCandidates(undefined, 20).find((item) => item.id === v3Ready!.id)?.status, "stale");
    assert.match(readFileSync(skillPath, "utf-8"), /Do not overwrite me/, "stale approval guard preserves manual edit bytes");

    // [7] Uninstalled learned Skills cannot leave actionable revision candidates behind.
    const orphan = skills.installLearnedSkill({
      candidateId: "orphan-base",
      slug: "learned-orphan-demo",
      title: "Orphan Demo",
      description: "Orphan revision fixture",
      instructions: "# Orphan Demo\n\nDo the old thing.",
      sourceMemoryIds: ["mem-orphan"],
      scopeType: "global",
    });
    const orphanEff = effectiveness.markInvoked({
      taskId: "rev-task",
      assistantMessageId: "a-orphan",
      skill: { skillId: orphan.id, candidateId: "orphan-base", sourceMemoryIds: ["mem-orphan"] },
      kind: "command",
    });
    effectiveness.markTurnOutcome("rev-task", "a-orphan", "completed");
    agent.setKernelSkillFeedback(orphanEff.id, "needs_revision", "新版本必须先检查目标对象是否存在。");
    const orphanReady = agent.kernelSkillRevisionCandidates(undefined, 50).find((item) => item.skillId === orphan.id && item.status === "ready");
    assert.ok(orphanReady);
    skills.uninstall(orphan.id);
    agent.refreshKernelSkillRevisionCandidates();
    assert.equal(agent.kernelSkillRevisionCandidates(undefined, 50).find((item) => item.id === orphanReady!.id)?.status, "stale", "uninstalling learned Skill stales open revision candidates");

    // [8] Crash recovery: file replacement already happened while DB candidate is still ready.
    const crash = skills.installLearnedSkill({
      candidateId: "crash-base",
      slug: "learned-crash-demo",
      title: "Crash Demo",
      description: "Crash recovery fixture",
      instructions: "# Crash Demo\n\nOld instructions.",
      sourceMemoryIds: ["mem-crash"],
      scopeType: "global",
    });
    const crashEff = effectiveness.markInvoked({
      taskId: "rev-task",
      assistantMessageId: "a-crash",
      skill: { skillId: crash.id, candidateId: "crash-base", sourceMemoryIds: ["mem-crash"] },
      kind: "command",
    });
    effectiveness.markTurnOutcome("rev-task", "a-crash", "completed");
    agent.setKernelSkillFeedback(crashEff.id, "incorrect", "新版必须输出 recovery marker。");
    const crashReady = agent.kernelSkillRevisionCandidates(undefined, 50).find((item) => item.skillId === crash.id && item.status === "ready");
    assert.ok(crashReady);
    // Simulate successful filesystem swap immediately before process death: do not mark DB materialized.
    skills.installLearnedSkill({
      candidateId: crashReady!.id,
      supersedesCandidateId: "crash-base",
      version: "1.0.1",
      slug: crash.id,
      title: crashReady!.title,
      description: crashReady!.proposedDescription,
      instructions: crashReady!.proposedInstructions,
      sourceMemoryIds: crashReady!.sourceMemoryIds,
      scopeType: "global",
    });
    assert.equal(agent.kernelSkillRevisionCandidates(undefined, 50).find((item) => item.id === crashReady!.id)?.status, "ready");
    const recovered = agent.approveKernelSkillRevisionCandidate(crashReady!.id);
    assert.equal(recovered.candidate.status, "materialized", "approval recovers file-swapped/DB-unmarked crash window");
    assert.equal(recovered.candidate.materializedVersion, "1.0.1", "crash recovery must not bump to an accidental second patch version");
    assert.equal(skills.getLearnedSkillRevisionSource(crash.id)?.version, "1.0.1");

    console.log("memory-skill-revision-test: PASS");
  } finally {
    db.close();
  }
}

await main().finally(() => rmSync(root, { recursive: true, force: true }));
