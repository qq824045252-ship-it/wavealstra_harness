import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openBotComposerRuntime } from "../src/main/agent/work/BotComposerRuntime";
import { createBotComposerSkillAccess } from "../src/main/agent/work/BotComposerSkillAccess";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemorySkillEffectivenessService } from "../src/main/memory/MemorySkillEffectivenessService";
import { MemorySkillRevisionService } from "../src/main/memory/MemorySkillRevisionService";
import { SkillsService } from "../src/main/skills/SkillsService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { ensureBotSkillScope } from "../src/main/db/memory-skill-scope-schema";

export async function verifyBotSkillContract(db: AppDatabase): Promise<void> {
  const bots = new BotRegistry(db.connection);
  const works = new WorkService(db.connection, { bots });
  for (const botId of ["skill-a", "skill-b"]) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId,
    authorization: DESKTOP_USER_GRANTS });
  const actor = { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS } as const;
  const created = works.createWork(actor, { operationId: "skill-create", ownerBotId: "skill-a", title: "Learn procedure",
    inputSnapshotId: "skill-input", criteria: [{ id: "skill-criterion", text: "verified" }], authorization: DESKTOP_USER_GRANTS });
  assert.ok(created.ok);
  db.upsertTask({ id: "skill-executor-task", title: "Executor B", updatedAt: Date.now(), status: "completed" });
  const dispatched = works.dispatchExecution(actor, { operationId: "skill-dispatch", workId: created.work.workId,
    botId: "skill-b", taskId: "skill-executor-task", durableStoreKey: "skill-store", conversationId: "skill-conv", workspaceBinding: "skill-workspace" });
  assert.ok(dispatched.ok);
  const memory = new MemoryService(db, { semantic: false });
  const procedure = memory.create({ kind: "procedure", title: "B verified method", content: "First inspect the inputs, then validate the output before delivery.",
    scopeType: "work", scopeId: created.work.workId, sourceTaskId: "skill-executor-task", sourceType: "agent", explicit: true, confidence: 1, importance: 2 });
  memory.learning.refreshMemory(procedure.id);
  const candidate = memory.learning.list().find(item => item.sourceMemoryIds.includes(procedure.id));
  assert.ok(candidate);
  assert.equal(candidate.scopeType, "bot");
  assert.equal(candidate.scopeId, "skill-b", "actual executor owns method, initiating owner A does not");
  const skills = new SkillsService();
  const installed = skills.installLearnedSkill({ ...candidate, candidateId: candidate.id });
  memory.learning.markMaterialized(candidate.id, installed.id);
  skills.setEnabled(installed.id, true, { botId: "skill-b" });
  const restarted = new SkillsService();
  assert.equal(restarted.listInstalled().some(item => item.id === installed.id), false);
  assert.equal(restarted.resolveRuntimeSkills(undefined, [], undefined, { botId: "skill-a" }).dtos.some(item => item.id === installed.id), false);
  assert.equal(restarted.resolveRuntimeSkills(undefined, [], undefined, { botId: "skill-b" }).dtos.some(item => item.id === installed.id), true);
  const source = restarted.getLearnedSkillRevisionSource(installed.id);
  assert.ok(source);
  assert.equal(source.scopeId, "skill-b");
  const copied = join(dirname(dirname(source.filePath)), "..", "frozen-private-skill");
  cpSync(dirname(source.filePath), copied, { recursive: true });
  const publicDirectory = join(copied, "..", "public-skill");
  mkdirSync(publicDirectory, { recursive: true });
  writeFileSync(join(publicDirectory, "SKILL.md"), "Public instructions");
  const composer = (botId: string, shared = false) => openBotComposerRuntime({
    profile: { expertId: "fixture", revision: "1", version: 1, systemPromptHash: "", capturedAt: 0,
      allowedMcpIds: [], allowedConnectorIds: [], allowedSkillIds: [installed.id, "public-skill"],
      skillPackages: [{ id: installed.id, directory: copied, origin: "global" }, { id: "public-skill", directory: publicDirectory, origin: "global" }] },
    cwd: copied, models: {} as ModelRuntime, connectorSkillRoots: [], enabledMcpIds: [], readOnly: () => true,
    skillAccess: createBotComposerSkillAccess({ identity: { botId, shared },
      current: id => restarted.getLearnedSkillRevisionSource(id),
      runnable: (id, ids) => memory.learning.isInstalledSkillRunnable(id, ids) }),
  });
  const privateRuntime = await composer("skill-b");
  const read = (runtime: typeof privateRuntime, skillId = installed.id) => runtime.tools.find(tool => tool.name === "read_skill")!
    .execute({ skillId }, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.ok((await read(privateRuntime)).output?.length, "own private frozen Skill is readable");
  const frozenText = readFileSync(join(copied, "SKILL.md"), "utf8");
  writeFileSync(join(copied, "SKILL.md"), `${frozenText}\nUnverified changed method`);
  await assert.rejects(read(privateRuntime), /已变化/, "copied content must still match the installed semantic hash");
  writeFileSync(join(copied, "SKILL.md"), frozenText);
  restarted.setEnabled(installed.id, false, { botId: "skill-b" });
  await assert.rejects(read(privateRuntime), /已变化/, "disabling installation revokes a copied package immediately");
  restarted.setEnabled(installed.id, true, { botId: "skill-b" });
  for (const runtime of [await composer("skill-a"), await composer("skill-b", true)]) {
    assert.ok(!runtime.instructions.includes(installed.id), "private skill is excluded before advertisement");
    await assert.rejects(read(runtime), /不属于/);
    assert.ok((await read(runtime, "public-skill")).output?.length);
    await runtime.close();
  }
  db.connection.prepare("UPDATE memory_records SET valid_until=? WHERE id=?").run(Date.now() - 1, procedure.id);
  assert.equal(memory.learning.isInstalledSkillRunnable(installed.id, candidate.sourceMemoryIds), false, "expired methods cannot execute");
  db.connection.prepare("UPDATE memory_records SET valid_until=NULL WHERE id=?").run(procedure.id);
  assert.equal(memory.learning.isInstalledSkillRunnable(installed.id, candidate.sourceMemoryIds), true);
  assert.throws(() => restarted.installLearnedSkill({ ...candidate, candidateId: candidate.id, scopeId: "skill-a" }), /归属/);
  const effectiveness = new MemorySkillEffectivenessService(db);
  const exposure = effectiveness.markInvoked({ taskId: "skill-executor-task", assistantMessageId: "skill-response",
    skill: { skillId: installed.id, candidateId: candidate.id, sourceMemoryIds: candidate.sourceMemoryIds }, kind: "read" });
  assert.throws(() => effectiveness.setWorkFeedback({ id: exposure.id, workId: created.work.workId, executorBotId: "skill-a",
    candidateId: candidate.id, kind: "incorrect", note: "validate twice" }), /执行 Bot/);
  assert.throws(() => effectiveness.setWorkFeedback({ id: exposure.id, workId: created.work.workId, executorBotId: "skill-b",
    candidateId: "old-version", kind: "incorrect", note: "validate twice" }), /版本/);
  effectiveness.setWorkFeedback({ id: exposure.id, workId: created.work.workId, executorBotId: "skill-b",
    candidateId: candidate.id, kind: "incorrect", note: "Validate output against a literal expected value." });
  const revisions = new MemorySkillRevisionService(db);
  const revision = revisions.refresh(source).candidate;
  assert.equal(revision?.status, "ready");
  assert.ok(revision);
  const revised = restarted.installLearnedSkill({ candidateId: revision.id, supersedesCandidateId: source.candidateId,
    version: "1.0.1", slug: installed.id, title: source.title, description: revision.proposedDescription,
    instructions: revision.proposedInstructions, scopeType: source.scopeType, scopeId: source.scopeId, sourceMemoryIds: source.sourceMemoryIds });
  revisions.markMaterialized(revision.id, revision.id, "1.0.1");
  assert.equal(restarted.getLearnedSkillRevisionSource(revised.id)?.candidateId, revision.id);
  await assert.rejects(read(privateRuntime), /已变化/, "already-open composer rejects superseded frozen version");
  await privateRuntime.close();
  cpSync(dirname(source.filePath), copied, { recursive: true, force: true });
  restarted.setEnabled(revised.id, true, { botId: "skill-b" });
  cpSync(dirname(source.filePath), copied, { recursive: true, force: true });
  const revisedRuntime = await composer("skill-b");
  assert.ok((await read(revisedRuntime)).output?.length);
  assert.match(readFileSync(revised.filePath!, "utf8"), /literal expected value/);
  assert.throws(() => restarted.installLearnedSkill({ ...candidate, candidateId: "stale-revision", supersedesCandidateId: candidate.id }), /过期/);
  memory.forget(procedure.id);
  await assert.rejects(read(revisedRuntime), /已变化/, "source forget immediately revokes already-open composer");
  await revisedRuntime.close();
  assert.equal(memory.learning.isInstalledSkillRunnable(installed.id, candidate.sourceMemoryIds), false);

  // Reproduce the previous current-schema CHECK, then migrate the real SQLite table.
  const beforeCandidates = db.connection.prepare("SELECT * FROM memory_skill_candidates ORDER BY id").all();
  const beforeRevisions = db.connection.prepare("SELECT * FROM memory_skill_revision_candidates ORDER BY id").all();
  db.connection.prepare("DELETE FROM memory_skill_candidates WHERE scope_type='bot'").run();
  const retained = db.connection.prepare("SELECT * FROM memory_skill_candidates ORDER BY id").all();
  const row = db.connection.prepare("SELECT sql FROM sqlite_master WHERE name='memory_skill_candidates'").get() as { sql: string };
  const indexes = db.connection.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='memory_skill_candidates' AND sql IS NOT NULL ORDER BY name")
    .all() as Array<{ sql: string }>;
  db.connection.exec(row.sql.replace("memory_skill_candidates", "old_skill_candidates").replace(
    "'global','workspace','project','bot'", "'global','workspace','project'"));
  db.connection.exec("INSERT INTO old_skill_candidates SELECT * FROM memory_skill_candidates; DROP TABLE memory_skill_candidates; ALTER TABLE old_skill_candidates RENAME TO memory_skill_candidates;");
  for (const index of indexes) db.connection.exec(index.sql);
  ensureBotSkillScope(db.connection);
  assert.deepEqual(db.connection.prepare("SELECT * FROM memory_skill_candidates ORDER BY id").all(), retained);
  assert.deepEqual(db.connection.prepare("SELECT * FROM memory_skill_revision_candidates ORDER BY id").all(), beforeRevisions);
  assert.deepEqual(db.connection.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='memory_skill_candidates' AND sql IS NOT NULL ORDER BY name").all(), indexes);
  assert.ok(beforeCandidates.length > retained.length);
  assert.ok(retained.some(row => (row as { scope_type: string }).scope_type === "project"));
  ensureBotSkillScope(db.connection);
}
