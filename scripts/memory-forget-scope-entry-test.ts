import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { ensureWorkTeamSchema } from "../src/main/agent/work/WorkTeamService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import type { MemoryCandidateDto, MemoryScopeType, MemorySearchRequest, MemoryTurnDto } from "../src/shared/memory-kernel";

// Real database, scope graph, MemoryService, persisted L0 and public review entry.
// Candidate JSON is controlled input: this is not model extraction / UI acceptance.
// Conversation and task scopes cannot legitimately span distinct conversations/tasks;
// those two cross-conversation cases are intentionally excluded, not made to pass
// by injecting an unauthorized scope hint.
const A = { title: "AsterPreference", content: "AsterPreference 的标记是紫杉7319" };
const B = { title: "HeliosCalibration", content: "HeliosCalibration 的标记是青丘8264" };
const BPending = { title: "HeliosMeasurementUnit", content: "HeliosMeasurementUnit 的默认单位为毫秒" };
type Layout = "same-message" | "different-message" | "different-conversation";
const scopes: MemoryScopeType[] = ["bot", "team", "conversation", "work", "project", "workspace", "task", "global"];
let cases = 0;
for (const scopeType of scopes) for (const layout of ["same-message", "different-message", "different-conversation"] as Layout[]) {
  if (layout === "different-conversation" && ["conversation", "task"].includes(scopeType)) continue;
  const db = new AppDatabase(":memory:");
  try {
    const bots = new BotRegistry(db.connection);
    for (const id of ["owner", "outsider"]) bots.registerBot({ botId: id, userId: LOCAL_USER_ID, displayName: id });
    ensureWorkTeamSchema(db.connection);
    for (const id of ["team-owner", "team-outsider"]) db.connection.prepare(
      "INSERT INTO work_team_templates(template_id,user_id,operation_id,request_hash,name,plan_json,created_at) VALUES(?,?,?,'hash',?,'{}',1)")
      .run(id, LOCAL_USER_ID, id, id);
    for (const id of ["project-owner", "project-outsider"]) db.connection.prepare(
      "INSERT INTO projects(id,name,created_at,updated_at,archived,resource_budget_chars) VALUES(?,?,1,1,0,128000)").run(id, id);
    const space = db.createSpace({ name: "owner workspace" }), otherSpace = db.createSpace({ name: "other workspace" });
    const messages = new BotConversationRepository(db.connection);
    const conversation = (botId: string, teamId?: string) => messages.accept(LOCAL_USER_ID,
      { botId, teamId, requestId: randomUUID(), text: "准备独立的记忆验收来源" }).conversationId;
    const c1 = conversation("owner", scopeType === "team" ? "team-owner" : undefined);
    const c2 = conversation("owner", scopeType === "team" ? "team-owner" : undefined);
    const foreign = conversation("outsider", scopeType === "team" ? "team-outsider" : undefined);
    for (const [id, projectId, spaceId] of [["task-one", "project-owner", space.id], ["task-two", "project-owner", space.id],
      ["task-other", "project-outsider", otherSpace.id]]) db.upsertTask({ id, projectId, spaceId, title: id, status: "completed", updatedAt: 1 });
    for (const [id, owner, project] of [["work-owner", "owner", "project-owner"], ["work-other", "outsider", "project-outsider"]]) {
      db.connection.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,project_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,'{}','intent','input','user',1,1)`).run(id, LOCAL_USER_ID, owner, project, id);
    }
    if (scopeType === "work") for (const [taskId, work, bot] of [["task-one", "work-owner", "owner"], ["task-two", "work-owner", "owner"], ["task-other", "work-other", "outsider"]]) {
      db.connection.prepare(`INSERT INTO work_execution_bindings(binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,intent_revision,owner_epoch,input_snapshot_id,expert_snapshot_json,workspace_binding,status,admitted_at)
        VALUES(?,?,?,?,?,?,?,1,1,'input','{}','fixture','completed',1)`).run(taskId, work, taskId, bot, taskId, taskId, taskId);
    }
    const ids: Record<MemoryScopeType, string | undefined> = { bot: "owner", team: "team-owner", conversation: c1, work: "work-owner",
      project: "project-owner", workspace: space.id, task: "task-one", global: undefined };
    const contexts: Record<MemoryScopeType, MemorySearchRequest> = { bot: { botId: "owner" }, team: { teamId: "team-owner" },
      conversation: { conversationId: c1 }, work: { taskId: "task-one" }, project: { taskId: "task-one" }, workspace: { taskId: "task-one" },
      task: { taskId: "task-one" }, global: {} };
    const outsiders: Record<MemoryScopeType, MemorySearchRequest> = { bot: { botId: "outsider" }, team: { teamId: "team-outsider" },
      conversation: { conversationId: foreign }, work: { taskId: "task-other" }, project: { taskId: "task-other" },
      workspace: { taskId: "task-other" }, task: { taskId: "task-other" }, global: { botId: "outsider" } };
    const scopeId = ids[scopeType], context = { ...contexts[scopeType], scopeTypes: [scopeType], includeInherited: false };
    const outsider = { ...outsiders[scopeType], scopeTypes: [scopeType], includeInherited: false };
    const memory = new MemoryService(db, { semantic: false }), pipeline = new MemoryPipelineManager(db);
    const conversationScope = ["bot", "team", "conversation"].includes(scopeType);
    const source1 = conversationScope ? c1 : "task-one";
    const source2 = layout === "different-conversation" ? (conversationScope ? c2 : "task-two") : source1;
    const capture = (taskId: string, text: string): MemoryTurnDto => pipeline.capture({ taskId, sessionId: taskId,
      userMessageId: randomUUID(), userText: text, assistantText: "", metadata: {} }).turn;
    const turnA = capture(source1, layout === "same-message" ? `${A.content}；${B.content}；${BPending.content}。` : `${A.content}。`);
    const turnB = layout === "same-message" ? turnA : capture(source2, `${B.content}；${BPending.content}。`);
    const create = (fact: typeof A, turn: MemoryTurnDto) => memory.create({ scopeType, scopeId, kind: "fact", sourceType: "user", explicit: true,
      title: fact.title, content: fact.content, confidence: 1, evidence: [{ evidenceKind: "conversation", refId: turn.id,
        excerpt: `用户：${turn.userText}\n助手：` }] });
    const atomA = create(A, turnA), atomB = create(B, turnB);
    assert(memory.search({ ...context, query: A.title }).some(hit => hit.memory.id === atomA.id));
    assert(memory.search({ ...context, query: B.title }).some(hit => hit.memory.id === atomB.id));
    // Legacy unshared global facts are intentionally inaccessible to Bot contexts.
    assert.equal(memory.getForRecall(atomB.id, outsider), undefined, `${scopeType} must not expose B outside its scope`);
    const stage = (fact: typeof A, turn: MemoryTurnDto): string => {
      const candidate: MemoryCandidateDto = { id: randomUUID(), taskId: turn.taskId, kind: "fact", title: fact.title, content: fact.content,
        scopeType, scopeId, confidence: 1, importance: 1, explicit: true, operationHint: "create", status: "needs_review", createdAt: turn.capturedAt,
        rawJson: JSON.stringify({ sourceTurnIds: [turn.id], userEvidence: fact.content }) };
      memory.repository.insertCandidate(candidate);
      return candidate.id;
    };
    // Both candidates are persisted before deletion, modelling delayed review/retry.
    const candidateA = stage(A, turnA), candidateB = stage(B, turnB), candidatePendingB = stage(BPending, turnB);
    assert.deepEqual(memory.detachScope(atomA.id, scopeType, scopeId), { detached: true, forgotten: true });
    assert.equal(memory.get(atomA.id), undefined);
    assert.equal(memory.getForRecall(atomA.id, context), undefined);
    assert(!memory.search({ ...context, query: A.title }).some(hit => hit.memory.content.includes("紫杉7319")));
    const recalledB = memory.getForRecall(atomB.id, context);
    assert(recalledB?.content.includes("青丘8264"));
    assert(!JSON.stringify(recalledB).includes("紫杉7319"), "retained B recall evidence must not leak withdrawn A");
    assert.equal(memory.resolveCandidateReview(candidateA, "approve").status, "rejected", "delayed A cannot revive even via approval");
    // Exact duplicates are rejected with resolvedMemoryId after eligible evidence is
    // attached. A withdrawal rejection has no memoryId. Assert both paths distinctly.
    assert.deepEqual(memory.resolveCandidateReview(candidateB, "approve"), { status: "rejected", memoryId: atomB.id },
      "eligible duplicate B must reach reconciliation, not source withdrawal");
    const pendingB = memory.resolveCandidateReview(candidatePendingB, "approve");
    assert.equal(pendingB.status, "committed", "unrelated old unextracted B remains eligible");
    assert(pendingB.memoryId);
    const newlyRecalledB = memory.getForRecall(pendingB.memoryId, context);
    assert.equal(newlyRecalledB?.content, BPending.content);
    assert(!JSON.stringify(newlyRecalledB).includes("紫杉7319"), "new B evidence cannot resurrect A");
    assert.equal(memory.getForRecall(pendingB.memoryId, outsider), undefined);
    assert(memory.search({ ...context, query: B.title }).some(hit => hit.memory.id === atomB.id));
    assert.equal(memory.getForRecall(atomB.id, outsider), undefined, "deletion/review cannot widen the original read scope");
    assert.equal(memory.repository.getCandidate(candidateA)?.status, "rejected");
    assert.equal((db.connection.prepare("SELECT resolved_memory_id FROM memory_candidates WHERE id=?").get(candidateB) as { resolved_memory_id: string }).resolved_memory_id, atomB.id);
    assert.equal(memory.repository.getCandidate(candidatePendingB)?.status, "committed");
    assert.equal((db.connection.prepare("SELECT count(*) n FROM memory_forget_watermarks").get() as { n: number }).n, 0,
      "one-record detach must not create a coarse scope cutoff");
    cases++; console.log(`PASS #41 service/candidate scope=${scopeType} layout=${layout}`);
  } finally { db.close(); }
}
assert.equal(cases, 22);
console.log("memory-forget-scope-entry-test: PASS (22 real service/review cases; no real model or UI)");
